// Who may see a restricted folder or file. No database here, so the tests run
// this file.
//
// A restricted folder or file is seen only by the people and teams named for
// it, and by global admins. A restricted folder covers everything inside it,
// so reaching a file means being let into every restricted folder on the way
// down, and into the file itself if that is restricted too.

/** What one caller may see, worked out once per request. */
export interface DocumentAccess {
  /** A global admin: nothing is hidden. */
  all: boolean;
  /** Folders the caller is shut out of: a restricted one they aren't named for, and everything inside it. */
  deniedFolders: ReadonlySet<string>;
  /** The families of the restricted files the caller is named for. */
  grantedFamilies: ReadonlySet<string>;
  /** The families of the files shared with the caller. */
  sharedFamilies: ReadonlySet<string>;
  /** The folders shared with the caller, and every folder inside one. */
  sharedFolders: ReadonlySet<string>;
}

export const SEES_EVERYTHING: DocumentAccess = {
  all: true,
  deniedFolders: new Set(),
  grantedFamilies: new Set(),
  sharedFamilies: new Set(),
  sharedFolders: new Set(),
};

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
 * Whether a file is shared with the caller: itself, or through a folder it is
 * in. Sharing lets someone who only sees their own uploads open it. It never
 * opens something restricted, which still needs them named there.
 */
export function fileShared(file: { folderId: string | null; familyId: string }, access: DocumentAccess): boolean {
  return access.sharedFamilies.has(file.familyId) || (!!file.folderId && access.sharedFolders.has(file.folderId));
}

/**
 * The folders a caller can't enter: each restricted folder they aren't named
 * for, and every folder beneath one. `granted` is the restricted folders they
 * are named for, in person or through a team.
 */
export function deniedFolderIds(
  folders: readonly { id: string; parentId: string | null; restricted: boolean }[],
  granted: ReadonlySet<string>,
): Set<string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const denied = new Set<string>();
  const verdicts = new Map<string, boolean>();
  const isDenied = (id: string, seen: Set<string>): boolean => {
    const known = verdicts.get(id);
    if (known !== undefined) return known;
    const folder = byId.get(id);
    if (!folder) return false;
    // A loop can't happen, but a bad row must not hang the request: shut it.
    if (seen.has(id)) return true;
    seen.add(id);
    const verdict = (folder.restricted && !granted.has(id)) || (folder.parentId !== null && isDenied(folder.parentId, seen));
    verdicts.set(id, verdict);
    return verdict;
  };
  for (const folder of folders) {
    if (isDenied(folder.id, new Set())) denied.add(folder.id);
  }
  return denied;
}

/** Whether the caller may see one file. */
export function fileVisible(
  file: { folderId: string | null; restricted: boolean; familyId: string },
  access: DocumentAccess,
): boolean {
  if (access.all) return true;
  if (file.folderId && access.deniedFolders.has(file.folderId)) return false;
  return !file.restricted || access.grantedFamilies.has(file.familyId);
}

/** What a file's history says when its sharing is saved. */
export function shareSummary(people: number, teams: number): string {
  if (people + teams === 0) return "Sharing removed";
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return `Shared with ${[people > 0 ? count(people, "person", "people") : "", teams > 0 ? count(teams, "team", "teams") : ""].filter(Boolean).join(" and ")}`;
}

/**
 * The people named for a restricted folder or file, as they will be stored.
 * Whoever restricts it keeps their own way in, so nobody locks themselves
 * out; a global admin sees everything anyway and is not added.
 */
export function accessPeople(personIds: readonly string[], callerId: string, callerIsGlobalAdmin: boolean): string[] {
  const people = new Set(personIds);
  if (!callerIsGlobalAdmin) people.add(callerId);
  return [...people];
}
