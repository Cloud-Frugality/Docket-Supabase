import type { ServiceClient } from "./service-client.ts";
import { selectAllRows, selectForIds } from "./paging.ts";
import { approverPool, groupPool, ruleFor, type ApprovalRule } from "./file-approval.ts";

// Where each waiting file's approval goes, read for many files at once: the
// group its category's rule names, or the team's default approvers.

type Row = Record<string, unknown>;

export interface Routing {
  /** The group the rule names; null for the default approvers. */
  groupId: string | null;
  groupName: string | null;
  /** Every member approves, rather than any one. */
  requiresAll: boolean;
  /** Who can approve it. Empty falls to the global admins. */
  pool: string[];
  /** Who of the pool has approved, where everyone must. */
  approvedIds: string[];
}

const ids = (rows: readonly Row[], pick: (row: Row) => unknown) =>
  [...new Set(rows.map(pick).filter((id): id is string => typeof id === "string"))];

/**
 * Each file's routing, by file id. `rows` are register rows. Pass
 * `selfApproval` where the organisation lets people approve their own.
 * Throws when a read fails, so a half-read pool approves nothing.
 */
export async function loadRouting(serviceClient: ServiceClient, rows: readonly Row[], selfApproval: boolean): Promise<Map<string, Routing>> {
  const out = new Map<string, Routing>();
  if (rows.length === 0) return out;
  const engagementOf = (row: Row) => (row.record === "engagement" ? row.record_id : null);
  const teamIds = ids(rows, (r) => r.team_id);
  const ruleColumns = "team_id, client_id, engagement_id, category_id, group_id";
  const rulesBy = (column: string, list: string[]) =>
    selectForIds(list, (chunk) => serviceClient.from("approval_rules").select(ruleColumns).in(column, chunk).order("id"));

  const [categories, teamRules, clientRules, engagementRules, approvers, admins] = await Promise.all([
    selectAllRows(() => serviceClient.from("document_categories").select("id, name").order("id")),
    rulesBy("team_id", teamIds),
    rulesBy("client_id", ids(rows, (r) => r.client_id)),
    rulesBy("engagement_id", ids(rows, engagementOf)),
    selectForIds(teamIds, (chunk) =>
      serviceClient.from("team_approvers").select("team_id, profile_id, profiles(status)").in("team_id", chunk).order("team_id").order("profile_id")),
    selectForIds(teamIds, (chunk) =>
      serviceClient.from("team_members").select("team_id, user_id").eq("role", "team_admin").in("team_id", chunk).order("id")),
  ]);
  const failed = categories.error ?? teamRules.error ?? clientRules.error ?? engagementRules.error ?? approvers.error ?? admins.error;
  if (failed) throw failed;

  const categoryId = new Map(categories.data.map((c) => [String(c.name), String(c.id)]));
  const rules: ApprovalRule[] = [...teamRules.data, ...clientRules.data, ...engagementRules.data].map((r) => ({
    teamId: (r.team_id as string | null) ?? null,
    clientId: (r.client_id as string | null) ?? null,
    engagementId: (r.engagement_id as string | null) ?? null,
    categoryId: String(r.category_id),
    groupId: String(r.group_id),
  }));
  const groupOf = new Map<string, string | null>();
  for (const row of rows) {
    groupOf.set(String(row.id), ruleFor(rules, {
      engagementId: (engagementOf(row) as string | null) ?? null,
      clientId: typeof row.client_id === "string" ? row.client_id : null,
      teamId: typeof row.team_id === "string" ? row.team_id : null,
      categoryId: categoryId.get(String(row.document_type)) ?? null,
    }));
  }

  const groupIds = [...new Set([...groupOf.values()].filter((id): id is string => !!id))];
  const [groups, members] = await Promise.all([
    selectForIds(groupIds, (chunk) => serviceClient.from("approver_groups").select("id, name, requires_all").in("id", chunk).order("id")),
    selectForIds(groupIds, (chunk) =>
      serviceClient.from("approver_group_members").select("group_id, profile_id, profiles(status)").in("group_id", chunk).order("group_id").order("profile_id")),
  ]);
  if (groups.error ?? members.error) throw groups.error ?? members.error;

  // Someone disabled can't approve, so they don't hold a file.
  const live = (r: Row) => (r.profiles as { status?: unknown } | null)?.status === "active";
  const liveApprovers = approvers.data.filter(live);
  const liveMembers = members.data.filter(live);
  const ofTeam = (data: Row[], key: string, teamId: unknown) => data.filter((r) => r.team_id === teamId).map((r) => String(r[key]));

  for (const row of rows) {
    const uploaderId = selfApproval || typeof row.uploaded_by !== "string" ? null : row.uploaded_by;
    const group = groups.data.find((g) => g.id === groupOf.get(String(row.id)));
    if (group) {
      const pool = groupPool(liveMembers.filter((m) => m.group_id === group.id).map((m) => String(m.profile_id)), uploaderId);
      out.set(String(row.id), {
        groupId: String(group.id),
        groupName: String(group.name),
        // With nobody left to ask it falls to the global admins, one of whom decides.
        requiresAll: group.requires_all === true && pool.length > 0,
        pool,
        approvedIds: [],
      });
    } else {
      out.set(String(row.id), {
        groupId: null,
        groupName: null,
        requiresAll: false,
        pool: approverPool(ofTeam(liveApprovers, "profile_id", row.team_id), ofTeam(admins.data, "user_id", row.team_id), uploaderId),
        approvedIds: [],
      });
    }
  }

  // The approvals given so far, for the files that need everyone's.
  const needAll = rows.filter((r) => out.get(String(r.id))?.requiresAll).map((r) => String(r.id));
  const given = await selectForIds(needAll, (chunk) =>
    serviceClient.from("document_approvals").select("record, document_id, profile_id").in("document_id", chunk).order("document_id").order("profile_id"));
  if (given.error) throw given.error;
  for (const row of rows) {
    const routing = out.get(String(row.id));
    if (!routing?.requiresAll) continue;
    routing.approvedIds = given.data
      .filter((a) => a.document_id === row.id && a.record === row.record && routing.pool.includes(String(a.profile_id)))
      .map((a) => String(a.profile_id));
  }
  return out;
}
