// Who may lock an item, add people to it and share it, and what someone at
// Documents Own reaches. Who SEES what is decided in SQL (register_for and
// places_for); this is the rest. Import-free, so the tests run this file.

export const ACCESS_KINDS = ["client", "engagement", "folder", "file"] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];

/** The most people one item can have added in one save. */
export const MAX_PEOPLE = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);

/** An item as a request names it: for a file, its family and which table it is in. */
export interface AccessTarget {
  kind: AccessKind;
  id: string;
  record: "client" | "engagement" | null;
}

export function parseAccessTarget(raw: { kind?: unknown; id?: unknown; record?: unknown }): AccessTarget | { error: string } {
  if (!(ACCESS_KINDS as readonly unknown[]).includes(raw.kind) || !isId(raw.id)) return { error: "Invalid item." };
  const kind = raw.kind as AccessKind;
  if (kind !== "file") return { kind, id: raw.id, record: null };
  if (raw.record !== "client" && raw.record !== "engagement") return { error: "Invalid item." };
  return { kind, id: raw.id, record: raw.record };
}

/** The people to add, one row each; the same person twice keeps Can edit if either says so. */
export function parseAccessPeople(raw: unknown): { personId: string; canEdit: boolean }[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return { error: "people must be a list." };
  const byId = new Map<string, boolean>();
  for (const entry of raw) {
    const person = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    if (!isId(person.personId)) return { error: "Everyone added needs a valid personId." };
    byId.set(person.personId, byId.get(person.personId) === true || person.canEdit === true);
  }
  if (byId.size > MAX_PEOPLE) return { error: "That is too many people." };
  return [...byId].map(([personId, canEdit]) => ({ personId, canEdit }));
}

/**
 * Locking an item and adding people to it is for global admins and the item's
 * team admins; a file's uploader may do it for their own file.
 */
export function mayManageAccess(input: {
  globalAdmin: boolean;
  adminTeamIds: readonly string[];
  teamId: string | null;
  uploadedByCaller: boolean;
}): boolean {
  return input.globalAdmin || (!!input.teamId && input.adminTeamIds.includes(input.teamId)) || input.uploadedByCaller;
}

/** Taking a share back: whoever gave it, the item's team admins, global admins. */
export function mayRemoveShare(input: {
  callerId: string;
  sharedBy: string | null;
  globalAdmin: boolean;
  adminTeamIds: readonly string[];
  teamId: string | null;
}): boolean {
  return input.sharedBy === input.callerId || input.globalAdmin || (!!input.teamId && input.adminTeamIds.includes(input.teamId));
}

export const LOCKED_SHARE = "A locked item can't be shared. Add the person to it instead.";
export const VIEW_ONLY = "You can view this file but not change it.";

/**
 * When a share runs out, as stored: null for never. A date alone lasts to the
 * end of that day (UTC). It has to be in the future.
 */
export function parseShareExpiry(raw: unknown, now: Date): { ok: true; expiresAt: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, expiresAt: null };
  if (typeof raw !== "string") return { ok: false, error: "expiresAt must be a date." };
  const text = raw.trim();
  const at = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T23:59:59.999Z`) : new Date(text);
  if (Number.isNaN(at.getTime())) return { ok: false, error: "expiresAt must be a date." };
  if (at.getTime() <= now.getTime()) return { ok: false, error: "A share has to end in the future." };
  return { ok: true, expiresAt: at.toISOString() };
}

/** What a file's history says when its lock or people change. */
export function accessSummary(restricted: boolean, people: number): string {
  const added = people === 0 ? "nobody added" : `${people} ${people === 1 ? "person" : "people"} added`;
  return `${restricted ? "Locked" : "Not locked"}, ${added}`;
}

/**
 * What the caller reaches by being added to an item or having it shared with
 * them (unexpired). Folders include every folder inside one.
 */
export interface Reach {
  clientIds: ReadonlySet<string>;
  engagementIds: ReadonlySet<string>;
  folderIds: ReadonlySet<string>;
  familyIds: ReadonlySet<string>;
}

/** The folders named and every folder inside one of them. */
export function foldersWithin(
  folders: readonly { id: string; parentId: string | null }[],
  roots: ReadonlySet<string>,
): Set<string> {
  const within = new Set(roots);
  // Each pass takes in the next level down; it stops when a pass adds nothing.
  let grew = within.size > 0;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId !== null && within.has(folder.parentId) && !within.has(folder.id)) {
        within.add(folder.id);
        grew = true;
      }
    }
  }
  return within;
}

/**
 * The register rows the caller reaches, as the parts of a PostgREST or(). A
 * client covers its engagements' files too, since they carry its client_id.
 */
export function reachParts(reach: Reach): string[] {
  const part = (column: string, ids: ReadonlySet<string>) => (ids.size > 0 ? [`${column}.in.(${[...ids].join(",")})`] : []);
  return [
    ...part("client_id", reach.clientIds),
    ...part("record_id", reach.engagementIds),
    ...part("folder_id", reach.folderIds),
    ...part("family_id", reach.familyIds),
  ];
}

/** Whether one register row is in what the caller reaches. */
export function rowInReach(row: Record<string, unknown>, reach: Reach): boolean {
  const has = (ids: ReadonlySet<string>, value: unknown) => typeof value === "string" && ids.has(value);
  return has(reach.clientIds, row.client_id) || has(reach.engagementIds, row.record_id) ||
    has(reach.folderIds, row.folder_id) || has(reach.familyIds, row.family_id);
}

/** The Documents Own filter: files I uploaded, and what I reach. */
export function ownScopeFilter(uploaderId: string, reach: Reach): string {
  return [`uploaded_by.eq.${uploaderId}`, ...reachParts(reach)].join(",");
}

/**
 * Why the caller can't use a client, engagement or folder, or null. One they
 * don't see reads as not there; changing it needs Can edit, which their
 * access role still caps.
 */
export function placeRefusal(
  place: { seen: boolean; canEdit: boolean } | null,
  intent: "read" | "write",
  label: string,
): { status: 403 | 404; error: string } | null {
  if (!place?.seen) return { status: 404, error: `${label[0].toUpperCase()}${label.slice(1)} not found.` };
  if (intent === "write" && !place.canEdit) return { status: 403, error: `You can't make changes to this ${label}.` };
  return null;
}
