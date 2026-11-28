import { internalError, jsonResponse } from "../_shared/http.ts";
import { withAuthorizedCaller } from "../_shared/serve.ts";
import { RATE_LIMIT_RESPONSE, takeRateLimitToken } from "../_shared/rate-limit.ts";
import type { ServiceClient } from "../_shared/service-client.ts";
import { buildDisplayNameMap } from "../_shared/display-names.ts";
import { appToday } from "../_shared/app-date.ts";
import { expiryForSave, isEmail, isIsoDateString, isPersonName, isUuid, MAX_NAME, overMaxLength } from "../_shared/validation.ts";
import { LEVEL_OWN, requirePermission, type AccessAction } from "../_shared/permissions.ts";
import { selectAllRows, selectForIds } from "../_shared/paging.ts";
import { normalizePersonDetails, normalizeSigning, touchesSigning } from "../_shared/person-rules.ts";
import { isLiveEntityOf } from "../_shared/legal-entities.ts";
import { effectiveCountry, loadOrgLocale } from "../_shared/organisation-locale.ts";

// People
// A person and their login are one profiles row keyed by the auth user id,
// created by the on_auth_user_created trigger on invite. Sign-up is invite
// only, so every person has a login. Users write covers the roster; anything
// touching access (inviting, roles, expiry, disabling, MFA, deleting) also
// needs Users & Access Roles write, so a Users write never widens access.
const PEOPLE_ENTITY = "Users";
const ACCOUNT_ENTITY = "Users & Access Roles";

/** At least one role is mandatory: an account with no role can reach nothing. */
function cleanRoleIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.some((id) => !isUuid(id))) return null;
  const ids = [...new Set(raw as string[])];
  return ids.length > 0 ? ids : null;
}

/**
 * Whether taking this login out of service would leave nobody with Users &
 * Access Roles write. Then nobody could put anyone back without a migration.
 * True means refuse.
 */
async function wouldStrandTheSystem(serviceClient: ServiceClient, userId: string): Promise<boolean> {
  const { data, error } = await serviceClient.rpc("other_active_administrators", { p_exclude_user: userId });
  // Fail closed: this is the one check whose failure can't be undone from the app.
  if (error) {
    console.error("other_active_administrators failed:", error.message ?? error);
    return true;
  }
  return (typeof data === "number" ? data : 0) < 1;
}

/** Whether a role set about to be written still grants administration. */
async function rolesKeepAdministrator(serviceClient: ServiceClient, roleIds: string[]): Promise<boolean> {
  const { data, error } = await serviceClient
    .from("access_role_permissions")
    .select("role_id, access_roles!inner(enabled)")
    .in("role_id", roleIds)
    .eq("entity", ACCOUNT_ENTITY)
    .gt("write_level", 0)
    .eq("access_roles.enabled", true)
    .limit(1);
  if (error) {
    console.error("rolesKeepAdministrator failed:", error.message ?? error);
    return false;
  }
  return (data ?? []).length > 0;
}

const LAST_ADMIN_ERROR =
  "This is the last administrator. Give somebody else Access Roles write first, or there will be nobody left who can restore access.";

function namesFrom(payload: Record<string, unknown>): { firstName: string; lastName: string } | string {
  const firstName = typeof payload.firstName === "string" ? payload.firstName.trim() : "";
  const lastName = typeof payload.lastName === "string" ? payload.lastName.trim() : "";
  if (!firstName || !lastName) return "First and last name are required.";
  if (!isPersonName(firstName) || !isPersonName(lastName)) {
    return "Names can only contain letters, spaces, hyphens, apostrophes, and periods.";
  }
  if (overMaxLength(firstName, MAX_NAME) || overMaxLength(lastName, MAX_NAME)) return "Names are too long.";
  return { firstName, lastName };
}

/** An optional yyyy-MM-dd expiry: undefined means untouched, null means none. */
function expiryFrom(value: unknown): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return isIsoDateString(value) ? value : false;
}

Deno.serve((request) =>
  withAuthorizedCaller(request, async ({ request, serviceClient, callerId }) => {
    // One rate-limit token per mutating request.
    if (request.method !== "GET") {
      const allowed = await takeRateLimitToken(serviceClient, `people:${callerId}`, 40, 1);
      if (!allowed) return jsonResponse({ error: RATE_LIMIT_RESPONSE.error }, request, RATE_LIMIT_RESPONSE.status);
    }

    if (request.method === "GET") {
      const perm = await requirePermission(serviceClient, callerId, PEOPLE_ENTITY, "read");
      if (!perm.ok) return jsonResponse({ error: perm.error }, request, perm.status);

      // Own on Users is the self view: "my own person" can only mean me.
      // Paged, because an unranged read stops at 1,000.
      const { data: people, error } = await selectAllRows(() => {
        let query = serviceClient
          .from("profiles")
          .select("id, first_name, last_name, email, status, expires_at, created_at, created_by, phone, country_code, employing_entity_id, can_sign, signing_limit, delegate_id, legal_entities(registered_name)");
        if (perm.level === LEVEL_OWN) query = query.eq("id", callerId);
        return query.order("last_name").order("first_name").order("id");
      });
      if (error) return internalError(request, error);

      const ids = (people ?? []).map((p) => String(p.id));
      // Creators and delegates are both people; one name map covers them.
      const creatorIds = (people ?? [])
        .flatMap((p) => [p.created_by, p.delegate_id])
        .filter((id): id is string => typeof id === "string");
      const [roleResult, displayNameById] = await Promise.all([
        ids.length > 0
          ? selectForIds(ids, (chunk) => serviceClient.from("user_access_roles").select("user_id, role_id").in("user_id", chunk))
          : Promise.resolve({ data: [], error: null }),
        buildDisplayNameMap(serviceClient, creatorIds),
      ]);
      if (roleResult.error) return internalError(request, roleResult.error);

      // Last sign-in lives on the login, not the profile. listUsers pages at
      // most 1,000 at a time.
      const lastSignInById = new Map<string, string>();
      // Never signed in and never confirmed: the invitation can be sent again.
      const invitePending = new Set<string>();
      for (let page = 1; ; page++) {
        const { data: users, error: usersError } = await serviceClient.auth.admin.listUsers({ page, perPage: 1000 });
        if (usersError) return internalError(request, usersError, "last sign-in");
        for (const u of users.users) {
          if (u.last_sign_in_at) lastSignInById.set(u.id, u.last_sign_in_at);
          else if (!u.email_confirmed_at) invitePending.add(u.id);
        }
        if (users.users.length < 1000) break;
      }

      const roleIdsByUser = new Map<string, string[]>();
      for (const row of roleResult.data ?? []) {
        if (typeof row.user_id !== "string" || typeof row.role_id !== "string") continue;
        roleIdsByUser.set(row.user_id, [...(roleIdsByUser.get(row.user_id) ?? []), row.role_id]);
      }

      return jsonResponse({
        people: (people ?? []).map((p) => ({
          id: String(p.id),
          firstName: typeof p.first_name === "string" ? p.first_name : "",
          lastName: typeof p.last_name === "string" ? p.last_name : "",
          email: typeof p.email === "string" ? p.email : "",
          status: p.status === "disabled" ? "disabled" : "active",
          expiresAt: typeof p.expires_at === "string" ? p.expires_at : null,
          roleIds: roleIdsByUser.get(String(p.id)) ?? [],
          createdAtUtc: typeof p.created_at === "string" ? p.created_at : "",
          createdByDisplayName: typeof p.created_by === "string"
            ? (displayNameById.get(p.created_by) ?? "Unknown")
            : "Unknown",
          lastSignInAtUtc: lastSignInById.get(String(p.id)) ?? null,
          invitePending: invitePending.has(String(p.id)),
          // What documents and approvals need.
          phone: typeof p.phone === "string" ? p.phone : "",
          countryCode: typeof p.country_code === "string" ? p.country_code : "",
          employingEntityId: typeof p.employing_entity_id === "string" ? p.employing_entity_id : null,
          employingEntityName: String((p.legal_entities as { registered_name?: unknown } | null)?.registered_name ?? ""),
          canSign: p.can_sign === true,
          signingLimit: p.signing_limit === null || p.signing_limit === undefined ? null : Number(p.signing_limit),
          delegateId: typeof p.delegate_id === "string" ? p.delegate_id : null,
          delegateName: typeof p.delegate_id === "string" ? (displayNameById.get(p.delegate_id) ?? "Unknown") : "",
        })),
      }, request);
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = await request.json();
    } catch {
      payload = {};
    }
    const action = typeof payload.action === "string" ? payload.action.trim().toLowerCase() : "";

    // One table binds each mutation to its permission. `account` marks the
    // actions that also need Users & Access Roles write.
    const mutations: Record<string, { permission: AccessAction; account: boolean; run: () => Promise<Response> }> = {
      create: { permission: "write", account: true, run: () => handleCreate() },
      update: { permission: "write", account: false, run: () => handleUpdate() },
      set_disabled: { permission: "write", account: true, run: () => handleSetDisabled() },
      reset_mfa: { permission: "write", account: true, run: () => handleResetMfa() },
      resend_invite: { permission: "write", account: true, run: () => handleResendInvite() },
      delete: { permission: "delete", account: true, run: () => handleDelete() },
    };
    const mutation = Object.hasOwn(mutations, action) ? mutations[action] : undefined;
    if (!mutation) return jsonResponse({ error: `Unknown action: ${action}` }, request, 400);

    const perm = await requirePermission(serviceClient, callerId, PEOPLE_ENTITY, mutation.permission);
    if (!perm.ok) return jsonResponse({ error: perm.error }, request, perm.status);
    const selfOnly = perm.level === LEVEL_OWN;
    if (mutation.account) {
      const accountPerm = await requirePermission(serviceClient, callerId, ACCOUNT_ENTITY, "write");
      if (!accountPerm.ok) {
        return jsonResponse({ error: "Managing platform access needs Access Roles write." }, request, 403);
      }
    }

    const personId = typeof payload.personId === "string" ? payload.personId.trim() : "";
    if (action !== "create") {
      if (!isUuid(personId)) return jsonResponse({ error: "Invalid personId." }, request, 400);
      // Own: you may change yourself and nobody else.
      if (selfOnly && personId !== callerId) {
        return jsonResponse({ error: "You can only change your own profile." }, request, 403);
      }
    }

    /**
     * The working details and signing authority a payload carries, checked:
     * signing needs Users & Access Roles write, the employing entity must be
     * one of ours, and a delegate another active person. Returns the columns
     * to write, or the refusal.
     */
    async function detailsUpdate(forPersonId: string | null): Promise<Record<string, unknown> | Response> {
      const details = normalizePersonDetails(payload, forPersonId);
      if ("error" in details) return jsonResponse({ error: details.error }, request, 400);
      // Locked to one country, the organisation's is the only one saved.
      if ("country_code" in details.value) {
        details.value.country_code = effectiveCountry(details.value.country_code ?? "", await loadOrgLocale(serviceClient));
      }
      const signing = normalizeSigning(payload);
      if ("error" in signing) return jsonResponse({ error: signing.error }, request, 400);
      if (touchesSigning(payload)) {
        const accountPerm = await requirePermission(serviceClient, callerId, ACCOUNT_ENTITY, "write");
        if (!accountPerm.ok) {
          return jsonResponse({ error: "Changing signing authority needs Access Roles write." }, request, 403);
        }
      }
      const entity = details.value.employing_entity_id;
      if (entity) {
        const { data: current } = forPersonId
          ? await serviceClient.from("profiles").select("employing_entity_id").eq("id", forPersonId).maybeSingle()
          : { data: null };
        // One already set passes even if since switched off.
        if (current?.employing_entity_id !== entity && !(await isLiveEntityOf(serviceClient, entity, null))) {
          return jsonResponse({ error: "The employing entity must be one of our live entities." }, request, 400);
        }
      }
      const delegate = details.value.delegate_id;
      if (delegate) {
        const { data } = await serviceClient.from("profiles").select("id").eq("id", delegate).eq("status", "active").maybeSingle();
        if (!data) return jsonResponse({ error: "The delegate must be an active person." }, request, 400);
      }
      return { ...details.value, ...signing.value };
    }

    // Invite: GoTrue mails the link, the trigger creates the profile from the
    // metadata, then the login gets its roles. Nothing is left behind on failure.
    async function handleCreate(): Promise<Response> {
      const names = namesFrom(payload);
      if (typeof names === "string") return jsonResponse({ error: names }, request, 400);
      const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
      if (!isEmail(email) || overMaxLength(email, MAX_NAME)) {
        return jsonResponse({ error: "A valid email address is required." }, request, 400);
      }
      const roleIds = cleanRoleIds(payload.roleIds);
      if (!roleIds) return jsonResponse({ error: "Select at least one access role." }, request, 400);
      const expiresAt = expiryFrom(payload.expiresAt);
      if (expiresAt === false) return jsonResponse({ error: "expiresAt must be a yyyy-MM-dd date." }, request, 400);

      const extra = await detailsUpdate(null);
      if (extra instanceof Response) return extra;

      const { data: taken } = await serviceClient.from("profiles").select("id").ilike("email", email).maybeSingle();
      if (taken) return jsonResponse({ error: "A person with that email already exists." }, request, 409);

      const { data: invited, error: inviteError } = await serviceClient.auth.admin.inviteUserByEmail(email, {
        data: { first_name: names.firstName, last_name: names.lastName, created_by: callerId },
      });
      if (inviteError) {
        if (/already.*(registered|exists)/i.test(String(inviteError.message))) {
          return jsonResponse({ error: "A login with that email already exists." }, request, 409);
        }
        return internalError(request, inviteError);
      }
      const userId = typeof invited?.user?.id === "string" ? invited.user.id : "";
      if (!userId) return internalError(request, new Error("Invite returned no user id."));

      // One transaction, so a login is never left with no roles.
      const { error: rolesError } = await serviceClient.rpc("replace_user_roles", {
        p_user_id: userId,
        p_role_ids: roleIds,
        p_actor: callerId,
      });
      const profileUpdate = { ...extra, ...(expiresAt === undefined ? {} : { expires_at: expiresAt }) };
      const { error: profileError } = rolesError || Object.keys(profileUpdate).length === 0
        ? { error: null }
        : await serviceClient.from("profiles").update(profileUpdate).eq("id", userId);
      if (rolesError || profileError) {
        await serviceClient.auth.admin.deleteUser(userId);
        return internalError(request, rolesError ?? profileError);
      }
      return jsonResponse({ message: "Invite sent.", id: userId }, request);
    }

    // Names and working details on any Users write; roles, expiry and
    // signing authority only with the account grant.
    async function handleUpdate(): Promise<Response> {
      const names = namesFrom(payload);
      if (typeof names === "string") return jsonResponse({ error: names }, request, 400);
      const extra = await detailsUpdate(personId);
      if (extra instanceof Response) return extra;
      const update: Record<string, unknown> = {
        first_name: names.firstName,
        last_name: names.lastName,
        ...extra,
        updated_by: callerId,
      };

      const wantsRoles = payload.roleIds !== undefined;
      const expiresAt = expiryFrom(payload.expiresAt);
      if (expiresAt === false) return jsonResponse({ error: "expiresAt must be a yyyy-MM-dd date." }, request, 400);
      if (wantsRoles || expiresAt !== undefined) {
        const accountPerm = await requirePermission(serviceClient, callerId, ACCOUNT_ENTITY, "write");
        if (!accountPerm.ok) {
          return jsonResponse({ error: "Changing access roles or expiry needs Access Roles write." }, request, 403);
        }
      }

      const { data: current, error: currentError } = await serviceClient
        .from("profiles")
        .select("status")
        .eq("id", personId)
        .maybeSingle();
      if (currentError) return internalError(request, currentError);
      if (!current) return jsonResponse({ error: "Person not found." }, request, 404);

      if (expiresAt !== undefined) {
        // A lapsed date sent back unchanged is dropped, or re-enabling would be
        // undone by the next hourly run.
        update.expires_at = expiryForSave(current.status === "disabled", expiresAt, appToday(new Date(), (await loadOrgLocale(serviceClient)).timeZone));
      }

      if (wantsRoles) {
        const roleIds = cleanRoleIds(payload.roleIds);
        if (!roleIds) return jsonResponse({ error: "Select at least one access role." }, request, 400);
        // Demoting the last administrator is refused; re-saving their roles is not.
        if (!(await rolesKeepAdministrator(serviceClient, roleIds)) && (await wouldStrandTheSystem(serviceClient, personId))) {
          return jsonResponse({ error: LAST_ADMIN_ERROR }, request, 400);
        }
        const { error: rolesError } = await serviceClient.rpc("replace_user_roles", {
          p_user_id: personId,
          p_role_ids: roleIds,
          p_actor: callerId,
        });
        if (rolesError) return internalError(request, rolesError);
      }

      const { error } = await serviceClient.from("profiles").update(update).eq("id", personId);
      if (error) return internalError(request, error);
      return jsonResponse({ message: "Person updated." }, request);
    }

    // Disabling bans the login (GoTrue's ~100-year ban) and zeroes every
    // permission; enabling lifts the ban and clears a lapsed expiry.
    async function handleSetDisabled(): Promise<Response> {
      const isDisabled = payload.isDisabled === true;
      if (isDisabled && personId === callerId) {
        return jsonResponse({ error: "You can't disable your own account." }, request, 400);
      }
      if (isDisabled && (await wouldStrandTheSystem(serviceClient, personId))) {
        return jsonResponse({ error: LAST_ADMIN_ERROR }, request, 400);
      }
      const { error: banError } = await serviceClient.auth.admin.updateUserById(personId, {
        ban_duration: isDisabled ? "876600h" : "none",
      });
      if (banError) return internalError(request, banError);
      const { error } = await serviceClient
        .from("profiles")
        .update(isDisabled
          ? { status: "disabled", updated_by: callerId }
          : { status: "active", expires_at: null, updated_by: callerId })
        .eq("id", personId);
      if (error) return internalError(request, error);
      return jsonResponse({ message: isDisabled ? "Person disabled." : "Person enabled." }, request);
    }

    // Someone who never took up their invitation gets it again. GoTrue sends a
    // fresh invite to a login that hasn't confirmed its email yet; one that has
    // is past this point and refused.
    async function handleResendInvite(): Promise<Response> {
      const { data: userData, error: getErr } = await serviceClient.auth.admin.getUserById(personId);
      if (getErr) return internalError(request, getErr);
      const user = userData?.user as { email?: string; email_confirmed_at?: string | null; last_sign_in_at?: string | null } | undefined;
      if (!user?.email) return jsonResponse({ error: "Person not found." }, request, 404);
      if (user.last_sign_in_at || user.email_confirmed_at) {
        return jsonResponse({ error: "This person has already accepted their invitation." }, request, 400);
      }
      const { data: profile } = await serviceClient.from("profiles").select("status").eq("id", personId).maybeSingle();
      if (profile?.status !== "active") return jsonResponse({ error: "Enable this person before inviting them again." }, request, 400);
      const { error: inviteError } = await serviceClient.auth.admin.inviteUserByEmail(user.email);
      if (inviteError) {
        // GoTrue spaces out emails to one address.
        if ((inviteError as { status?: number }).status === 429 || /seconds|rate/i.test(String(inviteError.message))) {
          return jsonResponse({ error: "An invitation was sent a moment ago. Wait a minute and try again." }, request, 429);
        }
        return internalError(request, inviteError);
      }
      return jsonResponse({ message: "Invitation sent again." }, request);
    }

    // A lost authenticator: remove every factor, so the MFA gate walks the person
    // through enrolment again on their next sign-in.
    async function handleResetMfa(): Promise<Response> {
      const { data: userData, error: getErr } = await serviceClient.auth.admin.getUserById(personId);
      if (getErr) return internalError(request, getErr);
      const factors = (userData?.user?.factors ?? []) as Array<{ id: string }>;
      for (const factor of factors) {
        const { error: factorErr } = await serviceClient.auth.admin.mfa.deleteFactor({ id: factor.id, userId: personId });
        if (factorErr) return internalError(request, factorErr);
      }
      // The admin API only lists verified factors; a leftover unverified one would
      // block re-enrolment with a friendly-name clash.
      const { error: purgeErr } = await serviceClient.rpc("purge_unverified_mfa_factors", { target_user: personId });
      if (purgeErr) return internalError(request, purgeErr);
      return jsonResponse({ message: "MFA reset. They will re-register an authenticator on next sign-in." }, request);
    }

    // Deleting the login cascades the profile. created_by columns reference
    // auth.users ON DELETE RESTRICT, so someone who authored records can't be
    // deleted; disable them instead.
    async function handleDelete(): Promise<Response> {
      if (personId === callerId) {
        return jsonResponse({ error: "You can't delete your own account." }, request, 400);
      }
      if (await wouldStrandTheSystem(serviceClient, personId)) {
        return jsonResponse({ error: LAST_ADMIN_ERROR }, request, 400);
      }
      const { error } = await serviceClient.auth.admin.deleteUser(personId);
      if (error) {
        if (/foreign key|violates|database error|unexpected failure/i.test(String(error.message))) {
          return jsonResponse({ error: "This person has created records that must be kept. Disable them instead." }, request, 409);
        }
        return internalError(request, error);
      }
      return jsonResponse({ message: "Person deleted." }, request);
    }

    return mutation.run();
  }));
