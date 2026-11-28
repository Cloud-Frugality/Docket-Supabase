import type { ServiceClient } from "./service-client.ts";
import type { CallerTeams } from "./permissions.ts";
import { selectAllRows } from "./paging.ts";
import { isUuid } from "./validation.ts";
import { foldersWithin, ownScopeFilter, reachParts, type Reach } from "./document-access.ts";

type Row = Record<string, unknown>;

// Who sees which client, engagement, folder and file is one rule in SQL
// (register_for, clients_for, engagements_for, folders_for, places_for). Every
// read on behalf of a caller starts from one of these, so PostgREST filters,
// orders, pages and counts what the caller sees. A read that skips them is a leak.

// deno-lint-ignore no-explicit-any
type Query = any;

/** Every file version the caller sees, as a query over the register's columns. */
export function registerFor(serviceClient: ServiceClient, callerId: string, columns: string, options?: Record<string, unknown>): Query {
  return serviceClient.rpc("register_for", { p_user: callerId }, options).select(columns);
}

/** The clients the caller sees, as rows of the clients table. */
export function clientsFor(serviceClient: ServiceClient, callerId: string, columns: string): Query {
  return serviceClient.rpc("clients_for", { p_user: callerId }).select(columns);
}

/** The engagements the caller sees, as rows of the engagements table. */
export function engagementsFor(serviceClient: ServiceClient, callerId: string, columns: string): Query {
  return serviceClient.rpc("engagements_for", { p_user: callerId }).select(columns);
}

/** The folders the caller sees, as rows of document_folders. */
export function foldersFor(serviceClient: ServiceClient, callerId: string, columns: string): Query {
  return serviceClient.rpc("folders_for", { p_user: callerId }).select(columns);
}

/** One client, engagement or folder as the caller stands to it. */
export interface Place {
  kind: string;
  id: string;
  teamId: string;
  recordId: string;
  seen: boolean;
  /** Before the access role caps it. */
  canEdit: boolean;
  /** Locked here or above, so it can't be shared. */
  locked: boolean;
}

/** Every place of one kind as the caller stands to it (seen or not). */
export function placesFor(serviceClient: ServiceClient, callerId: string): Query {
  return serviceClient.rpc("places_for", { p_user: callerId }).select("kind, id, team_id, record_id, seen, can_edit, locked");
}

const toPlace = (row: Row): Place => ({
  kind: String(row.kind),
  id: String(row.id),
  teamId: String(row.team_id),
  recordId: String(row.record_id),
  seen: row.seen === true,
  canEdit: row.can_edit === true,
  locked: row.locked === true,
});

/** How the caller stands to one place, or null when there is no such place. Throws on a read error. */
export async function placeFor(serviceClient: ServiceClient, callerId: string, kind: string, id: string): Promise<Place | null> {
  const { data, error } = await placesFor(serviceClient, callerId).eq("kind", kind).eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toPlace(data as Row) : null;
}

/** Whether the caller sees one file version. Throws on a read error. */
export async function fileSeen(serviceClient: ServiceClient, callerId: string, record: string, id: string): Promise<boolean> {
  const { count, error } = await registerFor(serviceClient, callerId, "id", { count: "exact", head: true }).eq("record", record).eq("id", id);
  if (error) throw error;
  return (count ?? 0) > 0;
}

/**
 * What the caller reaches by being added to an item or by a share that has
 * not run out, folders with everything inside them. It feeds the Documents
 * Own filter and Shared with Me. Throws rather than guess.
 */
export async function loadReach(serviceClient: ServiceClient, callerId: string, caller: CallerTeams): Promise<Reach> {
  const now = new Date().toISOString();
  const [added, shared] = await Promise.all([
    selectAllRows(() =>
      serviceClient.from("document_access").select("client_id, engagement_id, folder_id, family_id").eq("profile_id", callerId).order("id")
    ),
    selectAllRows(() => {
      const q = serviceClient.from("document_shares").select("client_id, engagement_id, folder_id, family_id");
      return (caller.teamIds.length > 0
        ? q.or(`profile_id.eq.${callerId},team_id.in.(${caller.teamIds.join(",")})`)
        : q.eq("profile_id", callerId))
        .or(`expires_at.is.null,expires_at.gt."${now}"`)
        .order("id");
    }),
  ]);
  if (added.error ?? shared.error) throw added.error ?? shared.error;

  const clientIds = new Set<string>();
  const engagementIds = new Set<string>();
  const roots = new Set<string>();
  const familyIds = new Set<string>();
  for (const row of [...added.data, ...shared.data]) {
    if (typeof row.client_id === "string") clientIds.add(row.client_id);
    if (typeof row.engagement_id === "string") engagementIds.add(row.engagement_id);
    if (typeof row.folder_id === "string") roots.add(row.folder_id);
    if (typeof row.family_id === "string") familyIds.add(row.family_id);
  }

  // A folder covers the folders inside it, so read the trees those folders sit in.
  let folderIds = new Set<string>();
  if (roots.size > 0) {
    const named = await serviceClient.from("document_folders").select("client_id, engagement_id").in("id", [...roots]);
    if (named.error) throw named.error;
    const owners = (column: string) => [...new Set(((named.data ?? []) as Row[]).map((f) => f[column]).filter((id): id is string => typeof id === "string"))];
    const parts = [
      ...(owners("client_id").length > 0 ? [`client_id.in.(${owners("client_id").join(",")})`] : []),
      ...(owners("engagement_id").length > 0 ? [`engagement_id.in.(${owners("engagement_id").join(",")})`] : []),
    ];
    const tree = parts.length > 0
      ? await selectAllRows(() => serviceClient.from("document_folders").select("id, parent_id").or(parts.join(",")).order("id"))
      : { data: [], error: null };
    if (tree.error) throw tree.error;
    folderIds = foldersWithin(
      tree.data.map((f) => ({ id: String(f.id), parentId: typeof f.parent_id === "string" ? f.parent_id : null })),
      roots,
    );
  }
  return { clientIds, engagementIds, folderIds, familyIds };
}

/**
 * Narrows a register query to what someone at Documents Own gets: what they
 * uploaded, and what they are added to or shared. No uploader means they see
 * every file they can see, so nothing is narrowed. The one place the Own
 * filter is built.
 */
export function applyOwnScope(query: Query, ownUploader: string | null, reach: Reach): Query {
  return ownUploader ? query.or(ownScopeFilter(ownUploader, reach)) : query;
}

/** Narrows a register query to Shared with Me, or null when nothing is shared with the caller. */
export function applyShared(query: Query, reach: Reach): Query | null {
  const parts = reachParts(reach);
  return parts.length > 0 ? query.or(parts.join(",")) : null;
}

/** The `teamId` a list was asked to narrow to: null for every team, false when it isn't an id. */
export function teamParam(params: URLSearchParams): string | null | false {
  const teamId = (params.get("teamId") ?? "").trim();
  if (!teamId) return null;
  return isUuid(teamId) ? teamId : false;
}

/**
 * Whether the caller may change a file (its access role still caps it). The
 * rule is file_can_edit in SQL: admins of its team and global admins; someone
 * added to it, as added; a locked file's first uploader; else Can edit where it
 * sits. Throws on a read error.
 */
export async function fileCanEdit(serviceClient: ServiceClient, callerId: string, record: string, familyId: string): Promise<boolean> {
  const { data, error } = await serviceClient.rpc("file_can_edit", { p_user: callerId, p_record: record, p_family: familyId });
  if (error) throw error;
  return data === true;
}
