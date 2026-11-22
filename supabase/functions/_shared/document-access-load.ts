import type { ServiceClient } from "./service-client.ts";
import type { CallerTeams } from "./permissions.ts";
import { selectAllRows } from "./paging.ts";
import { deniedFolderIds, fileShared, fileVisible, foldersWithin, type DocumentAccess } from "./document-access.ts";

type Row = Record<string, unknown>;

/**
 * What the caller may see of the restricted folders and files, and what is
 * shared with them. Read once per request and used by every list and every
 * single-file read. It throws rather than guess: a half-read access list must
 * hide, never show.
 */
export async function loadDocumentAccess(serviceClient: ServiceClient, callerId: string, caller: CallerTeams): Promise<DocumentAccess> {
  // The rows of one table that name the caller, in person or through a team.
  const mine = (table: string) =>
    selectAllRows(() => {
      const q = serviceClient.from(table).select("folder_id, family_id");
      return (caller.teamIds.length > 0
        ? q.or(`profile_id.eq.${callerId},team_id.in.(${caller.teamIds.join(",")})`)
        : q.eq("profile_id", callerId)).order("id");
    });
  const [restricted, grants, shares] = await Promise.all([
    selectAllRows(() => serviceClient.from("document_folders").select("id").eq("restricted", true).order("id")),
    mine("document_access"),
    mine("document_shares"),
  ]);
  const failed = restricted.error ?? grants.error ?? shares.error;
  if (failed) throw failed;

  const grantedFolders = new Set<string>();
  const grantedFamilies = new Set<string>();
  for (const grant of grants.data as Row[]) {
    if (typeof grant.folder_id === "string") grantedFolders.add(grant.folder_id);
    if (typeof grant.family_id === "string") grantedFamilies.add(grant.family_id);
  }
  const sharedRoots = new Set<string>();
  const sharedFamilies = new Set<string>();
  for (const share of shares.data as Row[]) {
    if (typeof share.folder_id === "string") sharedRoots.add(share.folder_id);
    if (typeof share.family_id === "string") sharedFamilies.add(share.family_id);
  }

  // A global admin is shut out of nothing.
  const shutOut = !caller.globalAdmin && (restricted.data as Row[]).some((f) => !grantedFolders.has(String(f.id)));
  // The whole tree is only needed when there is a folder to be shut out of, or one shared.
  let deniedFolders = new Set<string>();
  let sharedFolders = new Set<string>();
  if (shutOut || sharedRoots.size > 0) {
    const read = await selectAllRows(() => serviceClient.from("document_folders").select("id, parent_id, restricted").order("id"));
    if (read.error) throw read.error;
    const folders = (read.data as Row[]).map((f) => ({
      id: String(f.id),
      parentId: typeof f.parent_id === "string" ? f.parent_id : null,
      restricted: f.restricted === true,
    }));
    if (shutOut) deniedFolders = deniedFolderIds(folders, grantedFolders);
    sharedFolders = foldersWithin(folders, sharedRoots);
  }
  return { all: caller.globalAdmin, deniedFolders, grantedFamilies, sharedFamilies, sharedFolders };
}

/** Narrows a query over files (the register, or a document table) to what the caller may see. */
// deno-lint-ignore no-explicit-any
export function applyDocumentAccess(query: any, access: DocumentAccess) {
  if (access.all) return query;
  let q = query;
  if (access.deniedFolders.size > 0) q = q.or(`folder_id.is.null,folder_id.not.in.(${[...access.deniedFolders].join(",")})`);
  return access.grantedFamilies.size > 0
    ? q.or(`restricted.eq.false,family_id.in.(${[...access.grantedFamilies].join(",")})`)
    : q.eq("restricted", false);
}

// The files shared with the caller, as the parts of a PostgREST or().
function sharedParts(access: DocumentAccess): string[] {
  return [
    ...(access.sharedFamilies.size > 0 ? [`family_id.in.(${[...access.sharedFamilies].join(",")})`] : []),
    ...(access.sharedFolders.size > 0 ? [`folder_id.in.(${[...access.sharedFolders].join(",")})`] : []),
  ];
}

/**
 * Narrows a query to what someone who only sees their own files gets: what
 * they uploaded, and what is shared with them. No uploader means they see
 * every file, so nothing is narrowed.
 */
// deno-lint-ignore no-explicit-any
export function applyOwnScope(query: any, ownUploader: string | null, access: DocumentAccess) {
  if (!ownUploader) return query;
  const shared = sharedParts(access);
  return shared.length > 0 ? query.or([`uploaded_by.eq.${ownUploader}`, ...shared].join(",")) : query.eq("uploaded_by", ownUploader);
}

/** Narrows a query to the files shared with the caller, or null when nothing is. */
// deno-lint-ignore no-explicit-any
export function applyShared(query: any, access: DocumentAccess) {
  const shared = sharedParts(access);
  return shared.length > 0 ? query.or(shared.join(",")) : null;
}

/** Whether the caller may see one file row, as a document table or the register has it. */
export function rowVisible(row: Row, access: DocumentAccess): boolean {
  return fileVisible(
    { folderId: typeof row.folder_id === "string" ? row.folder_id : null, restricted: row.restricted === true, familyId: String(row.family_id) },
    access,
  );
}

/** Whether one file row is shared with the caller. */
export function rowShared(row: Row, access: DocumentAccess): boolean {
  return fileShared({ folderId: typeof row.folder_id === "string" ? row.folder_id : null, familyId: String(row.family_id) }, access);
}
