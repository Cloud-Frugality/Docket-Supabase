import { internalError, jsonResponse } from "../_shared/http.ts";
import { withAuthorizedCaller } from "../_shared/serve.ts";
import { RATE_LIMIT_RESPONSE, takeRateLimitToken } from "../_shared/rate-limit.ts";
import type { ServiceClient } from "../_shared/service-client.ts";
import { buildDisplayNameMap } from "../_shared/display-names.ts";
import { isCountryCode, isUniqueViolation, isUuid, MAX_NAME, overMaxLength } from "../_shared/validation.ts";
import { LEVEL_ALL, callerLevel, callerTeams } from "../_shared/permissions.ts";
import { selectAllRows, selectForIds } from "../_shared/paging.ts";
import { CURRENCIES, DATE_FORMATS, TIME_ZONES } from "../_shared/vocabularies.ts";
import { deleteEntity, isLiveEntityOf, listEntities, saveEntity } from "../_shared/legal-entities.ts";
import { effectiveCountry, effectiveCurrency, loadOrgLocale } from "../_shared/organisation-locale.ts";
import { TERM_KEYS, cleanTerm } from "../_shared/terms.ts";
import { idList } from "../_shared/list-links.ts";
import { parseTemplateFolders } from "../_shared/folder-templates.ts";
import { parseBinDays } from "../_shared/document-rules.ts";
import { parseUploadRules, storedUploadRules, uploadMimeTypes } from "../_shared/upload-rules.ts";
import { parseChecksOff, UPLOAD_CHECKS } from "../_shared/file-inspection.ts";
import { parseCategoryFields, storedFields } from "../_shared/document-fields.ts";
import { allowedDocumentTypes } from "../_shared/document-categories.ts";
import { draftRuleRight, parseGroupName, parseRetentionYears, RULE_SCOPES, type RuleScope } from "../_shared/file-approval.ts";
import {
  canManageMembers,
  cleanTeamDetails,
  MAX_BUSINESS_UNIT,
  normalizeTeamProfile,
  normalizeTeamSettings,
  normalizeMembers,
  normalizeTeamIds,
  personTeamsError,
  selfLockoutError,
  type TeamRole,
} from "../_shared/team-rules.ts";

// Organisation and teams
// Teams decide which team-owned records a person sees; access roles decide
// what they may do. A global admin is anyone with Users & Access Roles write;
// team admin is per team, on the membership row. There's one organisations
// row. The organisation's reference lists (engagement types) live here too.
const ADMIN_ENTITY = "Users & Access Roles";

async function isGlobalAdmin(serviceClient: ServiceClient, callerId: string): Promise<boolean> {
  return (await callerLevel(serviceClient, callerId, ADMIN_ENTITY, "write")) > 0;
}

/** The caller's role in one team, or null when they're not in it. */
async function roleInTeam(serviceClient: ServiceClient, teamId: string, userId: string): Promise<TeamRole | null> {
  const { data } = await serviceClient
    .from("team_members").select("role").eq("team_id", teamId).eq("user_id", userId).maybeSingle();
  return (data?.role as TeamRole | undefined) ?? null;
}

async function theOrganisation(serviceClient: ServiceClient) {
  return await serviceClient
    .from("organisations")
    .select("id, name, default_country_code, lock_country, default_currency, lock_currency, time_zone, date_format, clients_enabled, engagements_enabled, allow_self_approval, bin_retention_days, upload_types, upload_max_mb, upload_checks_off, client_term, clients_term, engagement_term, engagements_term")
    .order("created_at")
    .limit(1)
    .single();
}

Deno.serve((request) =>
  withAuthorizedCaller(request, async ({ request, serviceClient, callerId }) => {
  const globalAdmin = await isGlobalAdmin(serviceClient, callerId);

  // Whose approval rules these are: who may read and change them, and which
  // team's approver groups they can name besides the organisation's.
  type RuleTarget = { scope: RuleScope; id: string; teamId: string | null; clientId: string | null; canRead: boolean; canEdit: boolean };
  const ruleTarget = async (scope: unknown, id: unknown): Promise<RuleTarget | Response> => {
    if (!(RULE_SCOPES as readonly unknown[]).includes(scope) || !isUuid(id)) return jsonResponse({ error: "Invalid record." }, request, 400);
    const missing = () => jsonResponse({ error: "Record not found." }, request, 404);
    if (scope === "team") {
      const [{ data }, role] = await Promise.all([
        serviceClient.from("teams").select("id").eq("id", id).maybeSingle(),
        roleInTeam(serviceClient, id, callerId),
      ]);
      if (!data) return missing();
      return { scope, id, teamId: id, clientId: null, canRead: globalAdmin || !!role, canEdit: canManageMembers(globalAdmin, role) };
    }
    if (scope === "client") {
      const [{ data }, read, write] = await Promise.all([
        serviceClient.from("clients").select("id, created_by").eq("id", id).maybeSingle(),
        callerLevel(serviceClient, callerId, "Clients", "read"),
        callerLevel(serviceClient, callerId, "Clients", "write"),
      ]);
      if (!data) return missing();
      // Own on Clients is the clients you created.
      const own = data.created_by === callerId;
      return { scope: "client", id, teamId: null, clientId: id, canRead: read >= LEVEL_ALL || (read > 0 && own), canEdit: write >= LEVEL_ALL || (write > 0 && own) };
    }
    const [{ data }, read, write, teams] = await Promise.all([
      serviceClient.from("engagements").select("id, team_id, client_id").eq("id", id).maybeSingle(),
      callerLevel(serviceClient, callerId, "Engagements", "read"),
      callerLevel(serviceClient, callerId, "Engagements", "write"),
      callerTeams(serviceClient, callerId),
    ]);
    if (!data) return missing();
    // An engagement is changed by its owning team's members.
    const inTeam = globalAdmin || teams.teamIds.includes(String(data.team_id));
    return {
      scope: "engagement",
      id,
      teamId: String(data.team_id),
      clientId: String(data.client_id),
      canRead: read >= LEVEL_ALL || (read > 0 && inTeam),
      canEdit: write > 0 && inTeam,
    };
  };
  // A client or engagement not saved yet: no rules of its own, but the groups,
  // categories and fallbacks it will have once it is.
  const draftRuleTarget = async (teamId: string | null, clientId: string | null) => {
    if ((teamId && !isUuid(teamId)) || (clientId && !isUuid(clientId))) return jsonResponse({ error: "Invalid record." }, request, 400);
    // An engagement names its team; a client has none.
    const write = await callerLevel(serviceClient, callerId, teamId ? "Engagements" : "Clients", "write");
    const inTeam = !!teamId && !globalAdmin && !!(await roleInTeam(serviceClient, teamId, callerId));
    const { scope, allowed } = draftRuleRight({ teamId, writeLevel: write, inTeam, globalAdmin });
    return { scope: scope as RuleScope, id: null, teamId, clientId, canRead: allowed, canEdit: allowed };
  };
  const RULE_COLUMN: Record<RuleScope, string> = { team: "team_id", client: "client_id", engagement: "engagement_id" };

  // Reads
  if (request.method === "GET") {
    const url = new URL(request.url);
    const resource = url.searchParams.get("resource");

    // One team's members: for its own members and global admins.
    if (resource === "members") {
      const teamId = url.searchParams.get("teamId") ?? "";
      if (!isUuid(teamId)) return jsonResponse({ error: "A valid team id is required." }, request, 400);
      if (!globalAdmin && !(await roleInTeam(serviceClient, teamId, callerId))) {
        return jsonResponse({ error: "You are not a member of that team." }, request, 403);
      }
      const { data, error } = await selectAllRows(() =>
        serviceClient
          .from("team_members")
          .select("user_id, role, profiles!inner(full_name, email, status)")
          .eq("team_id", teamId)
          .order("user_id")
      );
      if (error) return internalError(request, error, "team members");
      const members = data
        .map((m) => {
          const p = m.profiles as { full_name: string; email: string; status: string };
          return { personId: m.user_id, name: p.full_name, email: p.email, status: p.status, role: m.role };
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return jsonResponse({ members }, request);
    }

    // One person's teams, for their detail drawer: themselves, anyone who
    // reads all of People, and global admins.
    if (resource === "person") {
      const personId = url.searchParams.get("personId") ?? "";
      if (!isUuid(personId)) return jsonResponse({ error: "A valid person id is required." }, request, 400);
      const allowed = globalAdmin || personId === callerId ||
        (await callerLevel(serviceClient, callerId, "Users", "read")) >= LEVEL_ALL;
      if (!allowed) return jsonResponse({ error: "You don't have permission to read that person's teams." }, request, 403);
      const { data, error } = await serviceClient
        .from("team_members")
        .select("team_id, role, teams!inner(name)")
        .eq("user_id", personId);
      if (error) return internalError(request, error, "person teams");
      const teams = (data ?? [])
        .map((m) => ({ teamId: m.team_id, name: (m.teams as unknown as { name: string }).name, role: m.role }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return jsonResponse({ teams }, request);
    }

    // How many records turning a lock on would move onto the default, for the
    // confirmation. Global admins only.
    if (resource === "locale_drift") {
      if (!globalAdmin) return jsonResponse({ error: "Only a global admin can change the organisation." }, request, 403);
      const country = (url.searchParams.get("country") ?? "").toUpperCase();
      const currency = (url.searchParams.get("currency") ?? "").toUpperCase();
      if (!isCountryCode(country) || !(CURRENCIES as readonly string[]).includes(currency)) {
        return jsonResponse({ error: "A valid country and currency are required." }, request, 400);
      }
      const { data, error } = await serviceClient.rpc("organisation_locale_drift", { p_country: country, p_currency: currency });
      if (error) return internalError(request, error, "locale drift");
      return jsonResponse({ drift: data }, request);
    }

    // What switching clients or engagements off would hide, for the confirmation.
    if (resource === "module_drift") {
      if (!globalAdmin) return jsonResponse({ error: "Only a global admin can change the organisation." }, request, 403);
      const { data, error } = await serviceClient.rpc("organisation_module_drift");
      if (error) return internalError(request, error, "module drift");
      return jsonResponse({ drift: data }, request);
    }

    // Our legal entities: every signed-in user reads them, since the forms
    // offer them.
    if (resource === "our_entities") {
      const result = await listEntities(serviceClient, null);
      return jsonResponse(result.body, request, result.status);
    }

    // Business units: every signed-in user reads them, with how many teams
    // sit in each.
    if (resource === "business_units") {
      const { data: units, error: unitErr } = await selectAllRows(() =>
        serviceClient.from("business_units").select("id, name, is_active").order("sort_order").order("id")
      );
      if (unitErr) return internalError(request, unitErr, "business units");
      const { data: teamUnits, error: useErr } = await selectAllRows(() =>
        serviceClient.from("teams").select("business_unit_id").not("business_unit_id", "is", null).order("id")
      );
      if (useErr) return internalError(request, useErr, "business unit use");
      const counts = new Map<string, number>();
      for (const t of teamUnits) counts.set(String(t.business_unit_id), (counts.get(String(t.business_unit_id)) ?? 0) + 1);
      return jsonResponse({
        units: units.map((u) => ({ id: u.id, name: u.name, isActive: u.is_active, teamCount: counts.get(String(u.id)) ?? 0 })),
      }, request);
    }

    // Engagement types: every signed-in user reads them (the engagement and
    // forms offer them), with how many engagements use each.
    if (resource === "engagement_types") {
      const { data: types, error: typeErr } = await selectAllRows(() =>
        serviceClient.from("engagement_types").select("id, name, sort_order, is_active").order("sort_order").order("id")
      );
      if (typeErr) return internalError(request, typeErr, "engagement types");
      const { data: uses, error: useErr } = await selectAllRows(() =>
        serviceClient.from("engagements").select("engagement_type_id").is("archived_at", null).order("id")
      );
      if (useErr) return internalError(request, useErr, "engagement type use");
      const counts = new Map<string, number>();
      for (const u of uses) counts.set(String(u.engagement_type_id), (counts.get(String(u.engagement_type_id)) ?? 0) + 1);
      // The business units each is offered to; none means all.
      const { data: links, error: linkErr } = await selectAllRows(() =>
        serviceClient.from("engagement_type_business_units").select("engagement_type_id, business_unit_id").order("engagement_type_id").order("business_unit_id")
      );
      if (linkErr) return internalError(request, linkErr, "engagement type units");
      return jsonResponse({
        types: types.map((t) => ({
          id: t.id,
          name: t.name,
          sortOrder: t.sort_order,
          isActive: t.is_active,
          engagementCount: counts.get(String(t.id)) ?? 0,
          businessUnitIds: links.filter((l) => l.engagement_type_id === t.id).map((l) => String(l.business_unit_id)),
        })),
      }, request);
    }

    // Document categories: every signed-in user reads them (the file forms
    // offer them), with how many files are of each.
    if (resource === "categories") {
      const { data: categories, error } = await selectAllRows(() =>
        serviceClient.from("document_categories").select("id, name, code, sort_order, is_active, is_binding, retention_years, fields").order("sort_order").order("id")
      );
      if (error) return internalError(request, error, "categories");
      const counts = new Map<string, number>();
      for (const table of ["engagement_documents", "client_documents"]) {
        const { data: uses, error: useErr } = await selectAllRows(() => serviceClient.from(table).select("document_type").order("id"));
        if (useErr) return internalError(request, useErr, "category use");
        for (const u of uses) counts.set(String(u.document_type), (counts.get(String(u.document_type)) ?? 0) + 1);
      }
      const [typeLinks, unitLinks] = await Promise.all([
        selectAllRows(() => serviceClient.from("document_category_engagement_types").select("category_id, engagement_type_id").order("category_id").order("engagement_type_id")),
        selectAllRows(() => serviceClient.from("document_category_business_units").select("category_id, business_unit_id").order("category_id").order("business_unit_id")),
      ]);
      if (typeLinks.error || unitLinks.error) return internalError(request, typeLinks.error ?? unitLinks.error, "category links");
      return jsonResponse({
        categories: categories.map((c) => ({
          id: c.id,
          name: c.name,
          code: c.code,
          sortOrder: c.sort_order,
          isActive: c.is_active,
          isBinding: c.is_binding,
          retentionYears: c.retention_years ?? null,
          fields: storedFields(c.fields),
          fileCount: counts.get(String(c.name)) ?? 0,
          engagementTypeIds: typeLinks.data.filter((l) => l.category_id === c.id).map((l) => String(l.engagement_type_id)),
          businessUnitIds: unitLinks.data.filter((l) => l.category_id === c.id).map((l) => String(l.business_unit_id)),
        })),
      }, request);
    }

    // The types a file on one client or engagement may be: the categories
    // offered to it. No record yet means every active category.
    if (resource === "document_types") {
      const record = url.searchParams.get("record") ?? "";
      const recordId = url.searchParams.get("recordId") ?? "";
      if ((record !== "engagement" && record !== "client") || (recordId && !isUuid(recordId))) {
        return jsonResponse({ error: "Invalid record." }, request, 400);
      }
      try {
        const allowed = await allowedDocumentTypes(serviceClient, record, recordId || null);
        return jsonResponse({
          types: allowed.types.map((name) => ({ name, binding: allowed.binding.includes(name), fields: allowed.fields?.[name] ?? [] })),
        }, request);
      } catch (error) {
        return internalError(request, error, "document types");
      }
    }

    // The folders new clients and engagements start with, for Settings.
    if (resource === "folder_templates") {
      if (!globalAdmin) return jsonResponse({ error: "Only a global admin can read the folder templates." }, request, 403);
      const { data, error } = await selectAllRows(() =>
        serviceClient.from("folder_templates").select("id, kind, team_id, engagement_type_id, folders").order("id")
      );
      if (error) return internalError(request, error, "folder templates");
      return jsonResponse({
        templates: data.map((t) => ({
          id: t.id,
          kind: t.kind,
          teamId: t.team_id ?? null,
          engagementTypeId: t.engagement_type_id ?? null,
          folders: Array.isArray(t.folders) ? t.folders : [],
        })),
      }, request);
    }

    // Approver groups: the organisation's, and one team's when a team is
    // named. Every signed-in user reads them, since the rules name them.
    if (resource === "approver_groups") {
      const teamId = url.searchParams.get("teamId") ?? "";
      if (teamId && !isUuid(teamId)) return jsonResponse({ error: "A valid team id is required." }, request, 400);
      const { data: groups, error } = await selectAllRows(() => {
        const q = serviceClient.from("approver_groups").select("id, team_id, name, requires_all");
        return (teamId ? q.or(`team_id.is.null,team_id.eq.${teamId}`) : q.is("team_id", null)).order("name").order("id");
      });
      if (error) return internalError(request, error, "approver groups");
      const groupIds = groups.map((g) => String(g.id));
      const [members, rules, role] = await Promise.all([
        selectForIds(groupIds, (chunk) =>
          serviceClient.from("approver_group_members").select("group_id, profile_id").in("group_id", chunk).order("group_id").order("profile_id")),
        selectForIds(groupIds, (chunk) => serviceClient.from("approval_rules").select("id, group_id").in("group_id", chunk).order("id")),
        teamId ? roleInTeam(serviceClient, teamId, callerId) : Promise.resolve(null),
      ]);
      if (members.error ?? rules.error) return internalError(request, members.error ?? rules.error, "approver group members");
      const names = await buildDisplayNameMap(serviceClient, members.data.map((m) => String(m.profile_id)));
      return jsonResponse({
        groups: groups.map((g) => ({
          id: g.id,
          teamId: g.team_id ?? null,
          name: g.name,
          requiresAll: g.requires_all === true,
          members: members.data
            .filter((m) => m.group_id === g.id)
            .map((m) => ({ personId: String(m.profile_id), name: names.get(String(m.profile_id)) ?? "Unknown" }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          ruleCount: rules.data.filter((r) => r.group_id === g.id).length,
        })),
        canEditOrganisation: globalAdmin,
        canEditTeam: !!teamId && canManageMembers(globalAdmin, role),
      }, request);
    }

    // One team's, client's or engagement's approval rules, with the groups
    // and categories a rule can name. An engagement also gets the rules it
    // falls back to: its client's, then its team's.
    if (resource === "approval_rules" || resource === "approval_rule_options") {
      const target = resource === "approval_rules"
        ? await ruleTarget(url.searchParams.get("scope"), url.searchParams.get("id"))
        : await draftRuleTarget(url.searchParams.get("teamId"), url.searchParams.get("clientId"));
      if (target instanceof Response) return target;
      if (!target.canRead) return jsonResponse({ error: "You don't have permission to read these approval rules." }, request, 403);
      const rulesOf = (scope: RuleScope, id: string) =>
        selectAllRows(() => serviceClient.from("approval_rules").select("id, category_id, group_id").eq(RULE_COLUMN[scope], id).order("id"));
      const none = Promise.resolve({ data: [] as Record<string, unknown>[], error: null });
      const [own, fromClient, fromTeam, groups, categories] = await Promise.all([
        target.id ? rulesOf(target.scope, target.id) : none,
        target.scope === "engagement" && target.clientId ? rulesOf("client", target.clientId) : none,
        target.scope === "engagement" && target.teamId ? rulesOf("team", target.teamId) : none,
        selectAllRows(() => {
          const q = serviceClient.from("approver_groups").select("id, team_id, name, requires_all");
          return (target.teamId ? q.or(`team_id.is.null,team_id.eq.${target.teamId}`) : q.is("team_id", null)).order("name").order("id");
        }),
        selectAllRows(() => serviceClient.from("document_categories").select("id, name, is_active, sort_order").order("sort_order").order("id")),
      ]);
      const failed = own.error ?? fromClient.error ?? fromTeam.error ?? groups.error ?? categories.error;
      if (failed) return internalError(request, failed, "approval rules");
      const shape = (r: Record<string, unknown>) => ({ categoryId: String(r.category_id), groupId: String(r.group_id) });
      return jsonResponse({
        rules: own.data.map(shape),
        inherited: [
          ...fromClient.data.map((r) => ({ ...shape(r), from: "client" })),
          ...fromTeam.data.map((r) => ({ ...shape(r), from: "team" })),
        ],
        groups: groups.data.map((g) => ({ id: g.id, teamId: g.team_id ?? null, name: g.name, requiresAll: g.requires_all === true })),
        categories: categories.data.map((c) => ({ id: c.id, name: c.name, isActive: c.is_active !== false })),
        canEdit: target.canEdit,
      }, request);
    }

    // The global admins themselves, for the Organisation settings.
    if (resource === "admins") {
      if (!globalAdmin) return jsonResponse({ error: "Only a global admin can list global admins." }, request, 403);
      const { data: grants, error: grantErr } = await serviceClient
        .from("access_role_permissions")
        .select("role_id, access_roles!inner(enabled)")
        .eq("entity", ADMIN_ENTITY)
        .gt("write_level", 0)
        .eq("access_roles.enabled", true);
      if (grantErr) return internalError(request, grantErr, "admin roles");
      const roleIds = Array.from(new Set<string>((grants ?? []).map((g) => String(g.role_id))));
      const { data: holders, error: holdErr } = await selectForIds(roleIds, (chunk) =>
        serviceClient.from("user_access_roles").select("user_id").in("role_id", chunk).order("user_id")
      );
      if (holdErr) return internalError(request, holdErr, "admin holders");
      const userIds = Array.from(new Set<string>(holders.map((h) => String(h.user_id))));
      const { data: people, error: peopleErr } = await selectForIds(userIds, (chunk) =>
        serviceClient.from("profiles").select("id, full_name, email").in("id", chunk).eq("status", "active").order("id")
      );
      if (peopleErr) return internalError(request, peopleErr, "admin profiles");
      const admins = people
        .map((p) => ({ personId: p.id, name: p.full_name, email: p.email }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return jsonResponse({ admins }, request);
    }

    // Default: the organisation, and the teams the caller can see (all of
    // them for a global admin, their own otherwise) with their role in each.
    const { data: org, error: orgErr } = await theOrganisation(serviceClient);
    if (orgErr) return internalError(request, orgErr, "organisation");
    const { data: mine, error: mineErr } = await serviceClient
      .from("team_members").select("team_id, role").eq("user_id", callerId);
    if (mineErr) return internalError(request, mineErr, "my teams");
    const myRole = new Map<string, TeamRole>((mine ?? []).map((m) => [String(m.team_id), m.role as TeamRole]));

    const { data: teams, error: teamErr } = globalAdmin
      ? await selectAllRows(() =>
        serviceClient.from("teams").select("id, name, country_code, is_active, created_at, default_entity_id, business_unit_id, region, reference_prefix, reference_pattern, default_currency, email, legal_entities(registered_name)").order("name")
      )
      : await selectForIds([...myRole.keys()], (chunk) =>
        serviceClient.from("teams").select("id, name, country_code, is_active, created_at, default_entity_id, business_unit_id, region, reference_prefix, reference_pattern, default_currency, email, legal_entities(registered_name)").in("id", chunk).order("name")
      );
    if (teamErr) return internalError(request, teamErr, "teams");

    const teamIds = teams.map((t) => t.id as string);
    const { data: memberRows, error: countErr } = await selectForIds(teamIds, (chunk) =>
      serviceClient.from("team_members").select("team_id, user_id, role").in("team_id", chunk).order("team_id")
    );
    if (countErr) return internalError(request, countErr, "team member counts");
    const counts = new Map<string, number>();
    for (const m of memberRows) counts.set(m.team_id as string, (counts.get(m.team_id as string) ?? 0) + 1);
    // A team's owners are its team admins, by name.
    const adminRows = memberRows.filter((m) => m.role === "team_admin");
    const ownerNames = await buildDisplayNameMap(serviceClient, adminRows.map((m) => String(m.user_id)));
    const owners = new Map<string, string[]>();
    for (const m of adminRows) {
      owners.set(String(m.team_id), [...(owners.get(String(m.team_id)) ?? []), ownerNames.get(String(m.user_id)) ?? "Unknown"]);
    }
    // Each team's default approvers.
    const { data: approverRows, error: approverErr } = await selectForIds(teamIds, (chunk) =>
      serviceClient.from("team_approvers").select("team_id, profile_id").in("team_id", chunk).order("team_id")
    );
    if (approverErr) return internalError(request, approverErr, "team settings");
    const approverNames = await buildDisplayNameMap(serviceClient, approverRows.map((a) => String(a.profile_id)));
    const approvers = new Map<string, { personId: string; name: string }[]>();
    for (const a of approverRows) {
      const id = String(a.profile_id);
      approvers.set(String(a.team_id), [...(approvers.get(String(a.team_id)) ?? []), { personId: id, name: approverNames.get(id) ?? "Unknown" }]);
    }

    return jsonResponse({
      organisation: {
        id: org.id,
        name: org.name,
        // The defaults every country and currency field starts on, and whether
        // they're locked.
        defaultCountryCode: org.default_country_code,
        lockCountry: org.lock_country === true,
        defaultCurrency: org.default_currency,
        lockCurrency: org.lock_currency === true,
        timeZone: org.time_zone,
        dateFormat: org.date_format,
        // Off: the organisation works without them, and they're hidden.
        clientsEnabled: org.clients_enabled !== false,
        engagementsEnabled: org.engagements_enabled !== false,
        // On: someone may approve a document they wrote.
        allowSelfApproval: org.allow_self_approval === true,
        binRetentionDays: typeof org.bin_retention_days === "number" ? org.bin_retention_days : null,
        // The kinds of file that may be uploaded, and how big one may be.
        uploadTypes: storedUploadRules(org.upload_types, org.upload_max_mb).types,
        uploadMaxMb: storedUploadRules(org.upload_types, org.upload_max_mb).maxMb,
        // The checks on an uploaded file that are switched off.
        uploadChecksOff: parseChecksOff(org.upload_checks_off) ?? [],
        // What the organisation calls a client and an engagement.
        terms: { client: org.client_term, clients: org.clients_term, engagement: org.engagement_term, engagements: org.engagements_term },
      },
      isGlobalAdmin: globalAdmin,
      teams: teams
        .map((t) => ({
          id: t.id,
          name: t.name,
          // The team's default entity for its documents; null falls back to the
          // organisation's default.
          defaultEntityId: t.default_entity_id ?? null,
          defaultEntityName: String((t.legal_entities as { registered_name?: unknown } | null)?.registered_name ?? ""),
          memberCount: counts.get(t.id as string) ?? 0,
          ownerNames: (owners.get(String(t.id)) ?? []).sort((a, b) => a.localeCompare(b)),
          countryCode: String(t.country_code ?? ""),
          businessUnitId: t.business_unit_id ?? null,
          region: String(t.region ?? ""),
          referencePrefix: typeof t.reference_prefix === "string" ? t.reference_prefix : null,
          referencePattern: String(t.reference_pattern ?? ""),
          defaultCurrency: String(t.default_currency ?? ""),
          email: String(t.email ?? ""),
          approvers: (approvers.get(String(t.id)) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
          isActive: t.is_active !== false,
          createdAtUtc: t.created_at,
          myRole: myRole.get(t.id as string) ?? null,
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    }, request);
  }

  // Mutations
  let payload: Record<string, unknown> = {};
  try {
    payload = await request.json();
  } catch {
    payload = {};
  }
  const action = typeof payload.action === "string" ? payload.action.trim().toLowerCase() : "";

  const allowed = await takeRateLimitToken(serviceClient, `teams:${callerId}`, 30, 0.5);
  if (!allowed) return jsonResponse(RATE_LIMIT_RESPONSE, request, 429);

  const GLOBAL_ONLY = "Only a global admin can do that.";

  const createTeam = async (): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: GLOBAL_ONLY }, request, 403);
    // A team is just its name.
    const details = cleanTeamDetails(payload.name, "");
    if ("error" in details) return jsonResponse({ error: details.error }, request, 400);
    // Teams aren't all in one country.
    const locale = await loadOrgLocale(serviceClient);
    const countryCode = effectiveCountry(typeof payload.countryCode === "string" ? payload.countryCode.trim().toUpperCase() : "", locale);
    if (!isCountryCode(countryCode)) return jsonResponse({ error: "A team needs its country." }, request, 400);
    const { data: org, error: orgErr } = await theOrganisation(serviceClient);
    if (orgErr) return internalError(request, orgErr, "organisation");
    const { data, error } = await serviceClient
      .from("teams")
      .insert({ organisation_id: org.id, name: details.name, country_code: countryCode, created_by: callerId })
      .select("id")
      .single();
    if (error) {
      if (isUniqueViolation(error)) return jsonResponse({ error: "A team with that name already exists." }, request, 409);
      return internalError(request, error, "team insert");
    }
    return jsonResponse({ message: "Team created.", id: data.id }, request);
  };

  const updateTeam = async (): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: GLOBAL_ONLY }, request, 403);
    const teamId = typeof payload.teamId === "string" ? payload.teamId : "";
    if (!isUuid(teamId)) return jsonResponse({ error: "A valid team id is required." }, request, 400);
    const details = cleanTeamDetails(payload.name, "");
    if ("error" in details) return jsonResponse({ error: details.error }, request, 400);
    const locale = await loadOrgLocale(serviceClient);
    const countryCode = effectiveCountry(typeof payload.countryCode === "string" ? payload.countryCode.trim().toUpperCase() : "", locale);
    if (!isCountryCode(countryCode)) return jsonResponse({ error: "A team needs its country." }, request, 400);
    const profile = normalizeTeamProfile(payload);
    if ("error" in profile) return jsonResponse({ error: profile.error }, request, 400);
    // Locked to one currency, a team's stays '' (the organisation's).
    if ("default_currency" in profile.value) {
      profile.value.default_currency = effectiveCurrency(profile.value.default_currency ?? "", locale, true);
    }
    if (profile.value.business_unit_id) {
      const { data: unit, error: unitErr } = await serviceClient
        .from("business_units").select("id").eq("id", profile.value.business_unit_id).maybeSingle();
      if (unitErr) return internalError(request, unitErr, "business unit");
      if (!unit) return jsonResponse({ error: "That business unit no longer exists." }, request, 400);
    }
    const { data, error } = await serviceClient
      .from("teams")
      // Inactive: out of the switcher and new work, but kept as it is.
      .update({
        name: details.name,
        country_code: countryCode,
        is_active: payload.isActive !== false,
        // Business unit, region, prefix and currency: only the ones the
        // caller sent, so the active switch alone leaves them be.
        ...profile.value,
        updated_at: new Date().toISOString(),
        updated_by: callerId,
      })
      .eq("id", teamId)
      .select("id");
    if (error) {
      if (isUniqueViolation(error)) {
        const prefixClash = (error as { message?: string }).message?.includes("reference_prefix");
        return jsonResponse({ error: prefixClash ? "Another team already uses that reference prefix." : "A team with that name already exists." }, request, 409);
      }
      return internalError(request, error, "team update");
    }
    if ((data ?? []).length === 0) return jsonResponse({ error: "Team not found." }, request, 404);
    return jsonResponse({ message: "Team updated." }, request);
  };

  const deleteTeam = async (): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: GLOBAL_ONLY }, request, 403);
    const teamId = typeof payload.teamId === "string" ? payload.teamId : "";
    if (!isUuid(teamId)) return jsonResponse({ error: "A valid team id is required." }, request, 400);
    // Memberships cascade away with the team; engagements it owns block the
    // delete (on delete restrict), so they have to move first.
    const { error } = await serviceClient.from("teams").delete().eq("id", teamId);
    if ((error as { code?: string } | null)?.code === "23503") {
      return jsonResponse({ error: "This team owns engagements. Move them to another team first." }, request, 409);
    }
    if (error) return internalError(request, error, "team delete");
    return jsonResponse({ message: "Team deleted." }, request);
  };

  const saveMembers = async (): Promise<Response> => {
    const teamId = typeof payload.teamId === "string" ? payload.teamId : "";
    if (!isUuid(teamId)) return jsonResponse({ error: "A valid team id is required." }, request, 400);
    if (!canManageMembers(globalAdmin, await roleInTeam(serviceClient, teamId, callerId))) {
      return jsonResponse({ error: "Only a team admin or a global admin can change this team's members." }, request, 403);
    }
    const normalized = normalizeMembers(payload.members);
    if ("error" in normalized) return jsonResponse({ error: normalized.error }, request, 400);
    const lockout = selfLockoutError(callerId, globalAdmin, normalized.rows);
    if (lockout) return jsonResponse({ error: lockout }, request, 400);

    // Every member must be a real, active person.
    const ids = normalized.rows.map((r) => r.user_id);
    const { data: found, error: findErr } = await selectForIds(ids, (chunk) =>
      serviceClient.from("profiles").select("id").in("id", chunk).eq("status", "active").order("id")
    );
    if (findErr) return internalError(request, findErr, "member lookup");
    if (found.length !== ids.length) {
      return jsonResponse({ error: "Every member must be an active person." }, request, 400);
    }

    const { error } = await serviceClient.rpc("replace_team_members", {
      p_team_id: teamId,
      p_rows: normalized.rows,
      p_actor: callerId,
    });
    if (error) return internalError(request, error, "team members replace");
    return jsonResponse({ message: "Team members saved." }, request);
  };

  // Adds one person to teams as a member, and takes them out of others, from
  // their drawer. The caller must run every team involved. Teams they're
  // already in are left as they are.
  const updatePersonTeams = async (): Promise<Response> => {
    const personId = typeof payload.personId === "string" ? payload.personId : "";
    if (!isUuid(personId)) return jsonResponse({ error: "A valid person id is required." }, request, 400);
    const adding = normalizeTeamIds(payload.addTeamIds);
    if ("error" in adding) return jsonResponse({ error: adding.error }, request, 400);
    const removing = normalizeTeamIds(payload.removeTeamIds);
    if ("error" in removing) return jsonResponse({ error: removing.error }, request, 400);
    const add = adding.ids;
    const remove = removing.ids;

    const [teams, mine, person] = await Promise.all([
      selectForIds(add, (chunk) => serviceClient.from("teams").select("id").in("id", chunk).eq("is_active", true).order("id")),
      serviceClient.from("team_members").select("team_id").eq("user_id", callerId).eq("role", "team_admin"),
      serviceClient.from("profiles").select("id").eq("id", personId).eq("status", "active").maybeSingle(),
    ]);
    if (teams.error || mine.error || person.error) {
      return internalError(request, teams.error ?? mine.error ?? person.error, "person teams lookup");
    }
    const refused = personTeamsError({
      callerId,
      personId,
      globalAdmin,
      adminOf: new Set((mine.data ?? []).map((m) => m.team_id)),
      add,
      remove,
    });
    if (refused) return jsonResponse({ error: refused }, request, 403);
    if (add.length > 0 && !person.data) return jsonResponse({ error: "Only an active person can join a team." }, request, 400);
    if (teams.data.length !== add.length) return jsonResponse({ error: "One of those teams is inactive or does not exist." }, request, 400);

    if (remove.length > 0) {
      const { error } = await serviceClient.from("team_members").delete().eq("user_id", personId).in("team_id", remove);
      if (error) return internalError(request, error, "remove from teams");
    }
    if (add.length > 0) {
      const { error } = await serviceClient.from("team_members").upsert(
        add.map((teamId) => ({ team_id: teamId, user_id: personId, role: "member", created_by: callerId })),
        { onConflict: "team_id,user_id", ignoreDuplicates: true },
      );
      if (error) return internalError(request, error, "add to teams");
    }
    return jsonResponse({ message: "Teams saved." }, request);
  };

  const updateOrganisation = async (): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: GLOBAL_ONLY }, request, 403);
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!name) return jsonResponse({ error: "An organisation name is required." }, request, 400);
    if (overMaxLength(name, MAX_NAME)) return jsonResponse({ error: `Name must be ${MAX_NAME} characters or fewer.` }, request, 400);
    const { data: org, error: orgErr } = await theOrganisation(serviceClient);
    if (orgErr) return internalError(request, orgErr, "organisation");
    // The default country and currency and their locks, when sent. Turning a lock
    // on moves the records that differ onto the default in the same transaction
    // (save_organisation_locale).
    const country = typeof payload.defaultCountryCode === "string" ? payload.defaultCountryCode.trim().toUpperCase() : org.default_country_code;
    const currency = typeof payload.defaultCurrency === "string" ? payload.defaultCurrency.trim().toUpperCase() : org.default_currency;
    if (!isCountryCode(country)) return jsonResponse({ error: "The default country must be a country." }, request, 400);
    if (!(CURRENCIES as readonly string[]).includes(currency)) {
      return jsonResponse({ error: `The default currency must be one of: ${CURRENCIES.join(", ")}.` }, request, 400);
    }
    const lockCountry = typeof payload.lockCountry === "boolean" ? payload.lockCountry : org.lock_country === true;
    const lockCurrency = typeof payload.lockCurrency === "boolean" ? payload.lockCurrency : org.lock_currency === true;
    const timeZone = typeof payload.timeZone === "string" ? payload.timeZone : org.time_zone;
    const dateFormat = typeof payload.dateFormat === "string" ? payload.dateFormat : org.date_format;
    if (!(TIME_ZONES as readonly string[]).includes(timeZone)) return jsonResponse({ error: "Pick a time zone from the list." }, request, 400);
    if (!(DATE_FORMATS as readonly string[]).includes(dateFormat)) return jsonResponse({ error: "Pick a date format from the list." }, request, 400);
    // An engagement always has a client, so engagements go off with clients.
    const clientsEnabled = typeof payload.clientsEnabled === "boolean" ? payload.clientsEnabled : org.clients_enabled !== false;
    const engagementsEnabled =
      clientsEnabled && (typeof payload.engagementsEnabled === "boolean" ? payload.engagementsEnabled : org.engagements_enabled !== false);
    const allowSelfApproval = typeof payload.allowSelfApproval === "boolean" ? payload.allowSelfApproval : org.allow_self_approval === true;
    // Kept unless sent; null switches the automatic delete off.
    const binDays = payload.binRetentionDays === undefined
      ? { ok: true as const, days: typeof org.bin_retention_days === "number" ? org.bin_retention_days : null }
      : parseBinDays(payload.binRetentionDays);
    if (!binDays.ok) return jsonResponse({ error: binDays.error }, request, 400);
    // What may be uploaded, changed only when both parts are sent.
    const upload = payload.uploadTypes === undefined || payload.uploadMaxMb === undefined
      ? null
      : parseUploadRules(payload.uploadTypes, payload.uploadMaxMb);
    if (upload && !upload.ok) return jsonResponse({ error: upload.error }, request, 400);
    // Its own words for a client and an engagement, each kept unless sent.
    const sent = (payload.terms && typeof payload.terms === "object" ? payload.terms : {}) as Record<string, unknown>;
    const terms: Record<string, string> = {};
    for (const key of TERM_KEYS) {
      if (sent[key] === undefined) continue;
      const term = cleanTerm(sent[key]);
      if ("error" in term) return jsonResponse({ error: term.error }, request, 400);
      terms[`${key}_term`] = term.value;
    }
    const { error: nameError } = await serviceClient
      .from("organisations")
      .update({
        name,
        ...terms,
        time_zone: timeZone,
        date_format: dateFormat,
        clients_enabled: clientsEnabled,
        engagements_enabled: engagementsEnabled,
        allow_self_approval: allowSelfApproval,
        bin_retention_days: binDays.days,
        updated_at: new Date().toISOString(),
        updated_by: callerId,
      })
      .eq("id", org.id);
    if (nameError) return internalError(request, nameError, "organisation update");
    if (upload?.ok) {
      // The storage buckets are set to the same limits in the same transaction.
      const { error: uploadError } = await serviceClient.rpc("save_upload_rules", {
        p_organisation_id: org.id,
        p_types: upload.rules.types,
        p_max_mb: upload.rules.maxMb,
        p_mime_types: uploadMimeTypes(upload.rules.types),
      });
      if (uploadError) return internalError(request, uploadError, "upload rules");
    }
    const { error } = await serviceClient.rpc("save_organisation_locale", {
      p_country: country,
      p_lock_country: lockCountry,
      p_currency: currency,
      p_lock_currency: lockCurrency,
      p_actor: callerId,
    });
    if (error) return internalError(request, error, "organisation locale");
    return jsonResponse({ message: "Organisation updated." }, request);
  };

  // POST { off }: which of the checks on an uploaded file are switched off. The whole list, each time.
  const saveUploadChecks = async (): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: GLOBAL_ONLY }, request, 403);
    const off = parseChecksOff(payload.off);
    if (!off || !Array.isArray(payload.off) || off.length !== new Set(payload.off).size) {
      return jsonResponse({ error: `The checks switched off must be a list of: ${UPLOAD_CHECKS.join(", ")}.` }, request, 400);
    }
    const { data: org, error: orgErr } = await theOrganisation(serviceClient);
    if (orgErr) return internalError(request, orgErr, "organisation");
    const { error } = await serviceClient
      .from("organisations")
      .update({ upload_checks_off: off, updated_at: new Date().toISOString(), updated_by: callerId })
      .eq("id", org.id);
    if (error) return internalError(request, error, "upload checks");
    return jsonResponse({ message: "Upload security saved." }, request);
  };

  // Engagement types: global admins keep the list. A type in use is switched off
  // rather than deleted, so no engagement loses its type.
  const typeDetails = () => {
    const details = cleanTeamDetails(payload.name, "", "engagement type");
    if ("error" in details) return details;
    const sortOrder = payload.sortOrder === undefined ? undefined : Number(payload.sortOrder);
    if (sortOrder !== undefined && (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000)) {
      return { error: "sortOrder must be a whole number from 0 to 10000." };
    }
    const unitIds = idList(payload.businessUnitIds);
    if (!unitIds) return { error: "Business units must be a list of business units." };
    return { ...details, sortOrder, unitIds };
  };

  // Saved with the type; a unit that has since gone refuses the lot.
  const saveTypeUnits = async (typeId: string, unitIds: string[]): Promise<Response | null> => {
    const { error } = await serviceClient.rpc("replace_engagement_type_units", { p_type_id: typeId, p_unit_ids: unitIds });
    if (!error) return null;
    if (error.code === "23503") return jsonResponse({ error: "One of those business units no longer exists." }, request, 400);
    return internalError(request, error, "engagement type units");
  };

  const createEngagementType = async (): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: GLOBAL_ONLY }, request, 403);
    const details = typeDetails();
    if ("error" in details) return jsonResponse({ error: details.error }, request, 400);
    const { data: org, error: orgErr } = await theOrganisation(serviceClient);
    if (orgErr) return internalError(request, orgErr, "organisation");
    const { data: last } = await serviceClient
      .from("engagement_types").select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
    const { data, error } = await serviceClient
      .from("engagement_types")
      .insert({
        organisation_id: org.id,
        name: details.name,
        sort_order: details.sortOrder ?? (Number(last?.sort_order ?? 0) + 1),
        created_by: callerId,
      })
      .select("id")
      .single();
    if (error) {
      if (isUniqueViolation(error)) return jsonResponse({ error: "An engagement type with that name already exists." }, request, 409);
      return internalError(request, error, "engagement type insert");
    }
    const unitsRefused = await saveTypeUnits(String(data.id), details.unitIds);
    if (unitsRefused) return unitsRefused;
    return jsonResponse({ message: "Engagement type created.", id: data.id }, request);
  };

  const updateEngagementType = async (): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: GLOBAL_ONLY }, request, 403);
    const typeId = typeof payload.typeId === "string" ? payload.typeId : "";
    if (!isUuid(typeId)) return jsonResponse({ error: "A valid engagement type id is required." }, request, 400);
    const details = typeDetails();
    if ("error" in details) return jsonResponse({ error: details.error }, request, 400);
    const update: Record<string, unknown> = {
      name: details.name,
      is_active: payload.isActive !== false,
      updated_at: new Date().toISOString(),
      updated_by: callerId,
    };
    if (details.sortOrder !== undefined) update.sort_order = details.sortOrder;
    const { data, error } = await serviceClient.from("engagement_types").update(update).eq("id", typeId).select("id");
    if (error) {
      if (isUniqueViolation(error)) return jsonResponse({ error: "An engagement type with that name already exists." }, request, 409);
      return internalError(request, error, "engagement type update");
    }
    if ((data ?? []).length === 0) return jsonResponse({ error: "Engagement type not found." }, request, 404);
    const unitsRefused = await saveTypeUnits(typeId, details.unitIds);
    if (unitsRefused) return unitsRefused;
    return jsonResponse({ message: "Engagement type updated." }, request);
  };

  // Business units: global admins keep the list. One in use is switched off
  // rather than deleted, so no team loses its unit.
  const unitName = (): { name: string } | { error: string } => {
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!name) return { error: "A business unit name is required." };
    if (name.length > MAX_BUSINESS_UNIT) return { error: `Business unit name must be ${MAX_BUSINESS_UNIT} characters or fewer.` };
    return { name };
  };

  const createBusinessUnit = async (): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: GLOBAL_ONLY }, request, 403);
    const details = unitName();
    if ("error" in details) return jsonResponse({ error: details.error }, request, 400);
    const { data: org, error: orgErr } = await theOrganisation(serviceClient);
    if (orgErr) return internalError(request, orgErr, "organisation");
    const { data: last } = await serviceClient
      .from("business_units").select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
    const { data, error } = await serviceClient
      .from("business_units")
      .insert({ organisation_id: org.id, name: details.name, sort_order: Number(last?.sort_order ?? 0) + 1, created_by: callerId })
      .select("id")
      .single();
    if (error) {
      if (isUniqueViolation(error)) return jsonResponse({ error: "A business unit with that name already exists." }, request, 409);
      return internalError(request, error, "business unit insert");
    }
    return jsonResponse({ message: "Business unit created.", id: data.id }, request);
  };

  const updateBusinessUnit = async (): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: GLOBAL_ONLY }, request, 403);
    const unitId = typeof payload.unitId === "string" ? payload.unitId : "";
    if (!isUuid(unitId)) return jsonResponse({ error: "A valid business unit id is required." }, request, 400);
    const details = unitName();
    if ("error" in details) return jsonResponse({ error: details.error }, request, 400);
    const { data, error } = await serviceClient
      .from("business_units")
      .update({ name: details.name, is_active: payload.isActive !== false, updated_at: new Date().toISOString(), updated_by: callerId })
      .eq("id", unitId)
      .select("id");
    if (error) {
      if (isUniqueViolation(error)) return jsonResponse({ error: "A business unit with that name already exists." }, request, 409);
      return internalError(request, error, "business unit update");
    }
    if ((data ?? []).length === 0) return jsonResponse({ error: "Business unit not found." }, request, 404);
    return jsonResponse({ message: "Business unit updated." }, request);
  };

  // Deleting works only on an entry nothing uses: the database refuses the
  // rest, and those are switched off instead.
  const deleteListEntry = async (table: "business_units" | "engagement_types", id: unknown, noun: string): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: GLOBAL_ONLY }, request, 403);
    if (!isUuid(id)) return jsonResponse({ error: `A valid ${noun} id is required.` }, request, 400);
    const { data, error } = await serviceClient.from(table).delete().eq("id", id).select("id");
    if (error) {
      if (error.code === "23503") return jsonResponse({ error: `This ${noun} is in use. Switch it off instead.` }, request, 409);
      return internalError(request, error, `${noun} delete`);
    }
    if ((data ?? []).length === 0) return jsonResponse({ error: "Not found." }, request, 404);
    return jsonResponse({ message: "Deleted." }, request);
  };
  const deleteBusinessUnit = () => deleteListEntry("business_units", payload.unitId, "business unit");
  const deleteEngagementType = () => deleteListEntry("engagement_types", payload.typeId, "engagement type");

  // One table binds each mutation to its handler; each handler checks its own
  // grant (global admin, or admin of the team in question).
  // Our legal entities: global admins keep the list.
  const saveOurEntity = async (): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: GLOBAL_ONLY }, request, 403);
    const result = await saveEntity(serviceClient, null, payload, callerId);
    return jsonResponse(result.body, request, result.status);
  };

  const deleteOurEntity = async (): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: GLOBAL_ONLY }, request, 403);
    const result = await deleteEntity(serviceClient, null, payload.entityId);
    return jsonResponse(result.body, request, result.status);
  };

  // A team's working settings: default entity (null falls back to the
  // organisation's), email, default approvers and categories. Its team admins
  // keep them, as global admins can; all four save together.
  const saveTeamSettings = async (): Promise<Response> => {
    const teamId = typeof payload.teamId === "string" ? payload.teamId : "";
    if (!isUuid(teamId)) return jsonResponse({ error: "A valid team id is required." }, request, 400);
    if (!canManageMembers(globalAdmin, await roleInTeam(serviceClient, teamId, callerId))) {
      return jsonResponse({ error: "Only a team admin or a global admin can change this team's settings." }, request, 403);
    }
    const settings = normalizeTeamSettings(payload);
    if ("error" in settings) return jsonResponse({ error: settings.error }, request, 400);
    const { defaultEntityId, email, approverIds } = settings.value;
    if (defaultEntityId && !(await isLiveEntityOf(serviceClient, defaultEntityId, null))) {
      return jsonResponse({ error: "That is not one of our live entities." }, request, 400);
    }
    const people = await selectForIds(approverIds, (chunk) =>
      serviceClient.from("profiles").select("id").in("id", chunk).eq("status", "active").order("id")
    );
    if (people.error) return internalError(request, people.error, "team settings lookup");
    if (people.data.length !== approverIds.length) return jsonResponse({ error: "Every approver must be an active person." }, request, 400);
    const { error } = await serviceClient.rpc("save_team_settings", {
      p_team_id: teamId,
      p_default_entity_id: defaultEntityId,
      p_email: email,
      p_approver_ids: approverIds,
      p_actor: callerId,
    });
    if (error) return internalError(request, error, "team settings");
    return jsonResponse({ message: "Team settings saved." }, request);
  };

  // Document categories: global admins keep the list. One that files use is
  // switched off rather than deleted, so no file loses its type.
  const saveDocumentCategory = async (): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: GLOBAL_ONLY }, request, 403);
    const details = cleanTeamDetails(payload.name, "", "category");
    if ("error" in details) return jsonResponse({ error: details.error }, request, 400);
    const code = typeof payload.code === "string" ? payload.code.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{0,10}$/.test(code)) return jsonResponse({ error: "A code is up to 10 capital letters or digits." }, request, 400);
    const typeIds = idList(payload.engagementTypeIds);
    const unitIds = idList(payload.businessUnitIds);
    if (!typeIds || !unitIds) return jsonResponse({ error: "Engagement types and business units must be lists." }, request, 400);
    // Years an approved file is kept. Not sent means unchanged.
    const retention = "retentionYears" in payload ? parseRetentionYears(payload.retentionYears) : null;
    if (retention && !retention.ok) return jsonResponse({ error: retention.error }, request, 400);
    // The fields its files answer. Not sent means unchanged.
    const fields = "fields" in payload ? parseCategoryFields(payload.fields) : null;
    if (fields && !fields.ok) return jsonResponse({ error: fields.error }, request, 400);
    // Saved with the category; one that has since gone refuses the lot.
    const saveLinks = async (id: string): Promise<Response | null> => {
      const { error } = await serviceClient.rpc("replace_document_category_links", { p_category_id: id, p_type_ids: typeIds, p_unit_ids: unitIds });
      if (!error) return null;
      if (error.code === "23503") return jsonResponse({ error: "One of those engagement types or business units no longer exists." }, request, 400);
      return internalError(request, error, "category links");
    };
    const duplicate = () => jsonResponse({ error: "A category with that name already exists." }, request, 409);

    const categoryId = typeof payload.categoryId === "string" ? payload.categoryId : "";
    if (categoryId) {
      if (!isUuid(categoryId)) return jsonResponse({ error: "Invalid category id." }, request, 400);
      // One transaction: a rename follows through to the files of that type.
      const { data: found, error } = await serviceClient.rpc("update_document_category", {
        p_category_id: categoryId,
        p_name: details.name,
        p_code: code,
        p_is_active: payload.isActive !== false,
        p_is_binding: payload.isBinding === true,
        p_actor: callerId,
      });
      if (error) return isUniqueViolation(error) ? duplicate() : internalError(request, error, "category update");
      if (found !== true) return jsonResponse({ error: "Category not found." }, request, 404);
      if (retention?.ok || fields?.ok) {
        const { error: keptError } = await serviceClient
          .from("document_categories")
          .update({ ...(retention?.ok ? { retention_years: retention.years } : {}), ...(fields?.ok ? { fields: fields.fields } : {}) })
          .eq("id", categoryId);
        if (keptError) return internalError(request, keptError, "category retention and fields");
      }
      return (await saveLinks(categoryId)) ?? jsonResponse({ message: "Category saved." }, request);
    }
    const { data: org, error: orgErr } = await serviceClient.from("organisations").select("id").order("created_at").limit(1).single();
    if (orgErr) return internalError(request, orgErr, "organisation");
    const { data: last } = await serviceClient
      .from("document_categories").select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
    const { data, error } = await serviceClient
      .from("document_categories")
      .insert({ organisation_id: org.id, name: details.name, code, is_binding: payload.isBinding === true, retention_years: retention?.ok ? retention.years : null, fields: fields?.ok ? fields.fields : [], sort_order: Number(last?.sort_order ?? 0) + 1, created_by: callerId })
      .select("id")
      .single();
    if (error) return isUniqueViolation(error) ? duplicate() : internalError(request, error, "category insert");
    return (await saveLinks(String(data.id))) ?? jsonResponse({ message: "Category created.", id: data.id }, request);
  };

  const deleteDocumentCategory = async (): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: GLOBAL_ONLY }, request, 403);
    const categoryId = payload.categoryId;
    if (!isUuid(categoryId)) return jsonResponse({ error: "Invalid category id." }, request, 400);
    const { data: category, error: readErr } = await serviceClient.from("document_categories").select("name").eq("id", categoryId).maybeSingle();
    if (readErr) return internalError(request, readErr, "category read");
    if (!category) return jsonResponse({ error: "Category not found." }, request, 404);
    // Files hold their type by name, so they are counted rather than left to a foreign key.
    for (const table of ["engagement_documents", "client_documents"]) {
      const { count, error } = await serviceClient.from(table).select("id", { count: "exact", head: true }).eq("document_type", category.name);
      if (error) return internalError(request, error, "category use");
      if ((count ?? 0) > 0) return jsonResponse({ error: "This category is in use. Switch it off instead." }, request, 409);
    }
    const { error } = await serviceClient.from("document_categories").delete().eq("id", categoryId);
    if (error) return internalError(request, error, "category delete");
    return jsonResponse({ message: "Category deleted." }, request);
  };

  // Approver groups: the organisation's are kept by global admins, a team's
  // by its team admins.
  const mayKeepGroups = async (teamId: string | null) =>
    teamId === null ? globalAdmin : canManageMembers(globalAdmin, await roleInTeam(serviceClient, teamId, callerId));
  const GROUPS_ONLY = (teamId: string | null) =>
    teamId === null
      ? "Only a global admin can change the organisation's approver groups."
      : "Only a team admin or a global admin can change this team's approver groups.";

  const saveApproverGroup = async (): Promise<Response> => {
    const teamId = payload.teamId === undefined || payload.teamId === null || payload.teamId === "" ? null : payload.teamId;
    if (teamId !== null && !isUuid(teamId)) return jsonResponse({ error: "A valid team id is required." }, request, 400);
    if (!(await mayKeepGroups(teamId))) return jsonResponse({ error: GROUPS_ONLY(teamId) }, request, 403);
    const groupId = payload.groupId === undefined || payload.groupId === null || payload.groupId === "" ? null : payload.groupId;
    if (groupId !== null && !isUuid(groupId)) return jsonResponse({ error: "Invalid group id." }, request, 400);
    const parsed = parseGroupName(payload.name);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, request, 400);
    const memberIds = idList(payload.memberIds);
    if (!memberIds) return jsonResponse({ error: "Members must be a list." }, request, 400);
    const people = await selectForIds(memberIds, (chunk) =>
      serviceClient.from("profiles").select("id").in("id", chunk).eq("status", "active").order("id")
    );
    if (people.error) return internalError(request, people.error, "group members lookup");
    if (people.data.length !== memberIds.length) return jsonResponse({ error: "Every member must be an active person." }, request, 400);
    const { data, error } = await serviceClient.rpc("save_approver_group", {
      p_group_id: groupId,
      p_team_id: teamId,
      p_name: parsed.name,
      p_requires_all: payload.requiresAll === true,
      p_member_ids: memberIds,
      p_actor: callerId,
    });
    if (error) {
      if (isUniqueViolation(error)) return jsonResponse({ error: "A group with that name already exists." }, request, 409);
      if (error.code === "23503") return jsonResponse({ error: "That team no longer exists." }, request, 400);
      return internalError(request, error, "approver group save");
    }
    if (!data) return jsonResponse({ error: "Group not found." }, request, 404);
    return jsonResponse({ message: "Group saved.", id: data }, request);
  };

  // Its rules go with it, and their categories fall back to the default approvers.
  const deleteApproverGroup = async (): Promise<Response> => {
    const groupId = payload.groupId;
    if (!isUuid(groupId)) return jsonResponse({ error: "Invalid group id." }, request, 400);
    const { data: group, error: readErr } = await serviceClient.from("approver_groups").select("id, team_id").eq("id", groupId).maybeSingle();
    if (readErr) return internalError(request, readErr, "approver group read");
    if (!group) return jsonResponse({ error: "Group not found." }, request, 404);
    const teamId = typeof group.team_id === "string" ? group.team_id : null;
    if (!(await mayKeepGroups(teamId))) return jsonResponse({ error: GROUPS_ONLY(teamId) }, request, 403);
    const { error } = await serviceClient.from("approver_groups").delete().eq("id", groupId);
    if (error) return internalError(request, error, "approver group delete");
    return jsonResponse({ message: "Group deleted." }, request);
  };

  // One category's rule on a team, a client or an engagement: set, changed,
  // or removed when no group is named.
  const setApprovalRule = async (): Promise<Response> => {
    const target = await ruleTarget(payload.scope, payload.id);
    if (target instanceof Response) return target;
    if (!target.canEdit) return jsonResponse({ error: "You don't have permission to change these approval rules." }, request, 403);
    const categoryId = payload.categoryId;
    if (!isUuid(categoryId)) return jsonResponse({ error: "Invalid category id." }, request, 400);
    const groupId = payload.groupId === undefined || payload.groupId === null || payload.groupId === "" ? null : payload.groupId;
    if (groupId !== null) {
      if (!isUuid(groupId)) return jsonResponse({ error: "Invalid group id." }, request, 400);
      const { data: group, error } = await serviceClient.from("approver_groups").select("id, team_id").eq("id", groupId).maybeSingle();
      if (error) return internalError(request, error, "approver group read");
      // The organisation's groups, or the groups of the team the record belongs to.
      if (!group || (group.team_id !== null && group.team_id !== target.teamId)) {
        return jsonResponse({ error: "That approver group can't be used here." }, request, 400);
      }
    }
    const { error } = await serviceClient.rpc("set_approval_rule", {
      p_scope: target.scope,
      p_id: target.id,
      p_category_id: categoryId,
      p_group_id: groupId,
      p_actor: callerId,
    });
    if (error) {
      if (error.code === "23503") return jsonResponse({ error: "That category or group no longer exists." }, request, 400);
      return internalError(request, error, "approval rule");
    }
    return jsonResponse({ message: groupId ? "Rule saved." : "Rule removed." }, request);
  };

  // One template for each thing it can be for: clients, or engagements of a
  // team, a type, both or neither. What it is for is fixed once it is made.
  const TEMPLATES_ONLY = "Only a global admin can change the folder templates.";
  const saveFolderTemplate = async (): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: TEMPLATES_ONLY }, request, 403);
    const parsed = parseTemplateFolders(payload.folders);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, request, 400);
    const stamp = { folders: parsed.folders, updated_by: callerId, updated_at: new Date().toISOString() };
    if (payload.templateId !== undefined && payload.templateId !== null) {
      if (!isUuid(payload.templateId)) return jsonResponse({ error: "Invalid template id." }, request, 400);
      const { data, error } = await serviceClient.from("folder_templates").update(stamp).eq("id", payload.templateId).select("id").maybeSingle();
      if (error) return internalError(request, error, "folder template update");
      if (!data) return jsonResponse({ error: "Template not found." }, request, 404);
      return jsonResponse({ message: "Template saved.", id: data.id }, request);
    }
    const kind = payload.kind;
    if (kind !== "client" && kind !== "engagement") return jsonResponse({ error: "A template is for clients or for engagements." }, request, 400);
    const optionalId = (value: unknown) => (value === undefined || value === null || value === "" ? null : value);
    const teamId = optionalId(payload.teamId);
    const engagementTypeId = optionalId(payload.engagementTypeId);
    if ((teamId !== null && !isUuid(teamId)) || (engagementTypeId !== null && !isUuid(engagementTypeId))) {
      return jsonResponse({ error: "Invalid team or engagement type." }, request, 400);
    }
    if (kind === "client" && (teamId || engagementTypeId)) {
      return jsonResponse({ error: "A client template has no team or engagement type." }, request, 400);
    }
    const { data, error } = await serviceClient
      .from("folder_templates")
      .insert({ kind, team_id: teamId, engagement_type_id: engagementTypeId, ...stamp })
      .select("id")
      .single();
    if (error) {
      if (isUniqueViolation(error)) return jsonResponse({ error: "There is already a template for that. Change that one instead." }, request, 409);
      if (error.code === "23503") return jsonResponse({ error: "That team or engagement type no longer exists." }, request, 400);
      return internalError(request, error, "folder template insert");
    }
    return jsonResponse({ message: "Template saved.", id: data.id }, request);
  };

  const deleteFolderTemplate = async (): Promise<Response> => {
    if (!globalAdmin) return jsonResponse({ error: TEMPLATES_ONLY }, request, 403);
    if (!isUuid(payload.templateId)) return jsonResponse({ error: "Invalid template id." }, request, 400);
    const { error } = await serviceClient.from("folder_templates").delete().eq("id", payload.templateId);
    if (error) return internalError(request, error, "folder template delete");
    return jsonResponse({ message: "Template deleted." }, request);
  };

  const MUTATIONS: Record<string, () => Promise<Response>> = {
    save_folder_template: saveFolderTemplate,
    delete_folder_template: deleteFolderTemplate,
    save_approver_group: saveApproverGroup,
    delete_approver_group: deleteApproverGroup,
    set_approval_rule: setApprovalRule,
    create_team: createTeam,
    update_team: updateTeam,
    delete_team: deleteTeam,
    save_members: saveMembers,
    update_person_teams: updatePersonTeams,
    update_organisation: updateOrganisation,
    save_upload_checks: saveUploadChecks,
    create_business_unit: createBusinessUnit,
    update_business_unit: updateBusinessUnit,
    delete_business_unit: deleteBusinessUnit,
    create_engagement_type: createEngagementType,
    update_engagement_type: updateEngagementType,
    delete_engagement_type: deleteEngagementType,
    save_document_category: saveDocumentCategory,
    delete_document_category: deleteDocumentCategory,
    save_our_entity: saveOurEntity,
    delete_our_entity: deleteOurEntity,
    save_team_settings: saveTeamSettings,
  };
  const run = Object.hasOwn(MUTATIONS, action) ? MUTATIONS[action] : undefined;
  if (!run) return jsonResponse({ error: `Unknown action: ${action}` }, request, 400);
  return run();
  }));
