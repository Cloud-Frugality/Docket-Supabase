// Folder rules for the Documents page. Import-free, so the tests run this file.

export const MAX_FOLDER_NAME = 120;

/** A folder's name as it will be stored, or why it can't be. */
export function parseFolderName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, error: "Give the folder a name." };
  if (name.length > MAX_FOLDER_NAME) return { ok: false, error: `A folder name can be at most ${MAX_FOLDER_NAME} characters.` };
  // The breadcrumb reads as a path, so a name can't look like one.
  if (/[\\/]/.test(name)) return { ok: false, error: "A folder name can't contain a slash." };
  if (!/[\p{L}\p{N}]/u.test(name)) return { ok: false, error: "A folder name needs at least one letter or number." };
  return { ok: true, name };
}

/** Why a folder can't be deleted yet, or null when it is empty. */
export function folderDeleteRefusal(contents: { folders: number; files: number }): string | null {
  if (contents.folders > 0 || contents.files > 0) return "Move or delete what is in this folder first.";
  return null;
}
