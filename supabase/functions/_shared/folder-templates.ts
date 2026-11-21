// Folder templates: the folders a new client or engagement starts with.
// No database here, so the tests run this file.

import { parseFolderName } from "./document-folders.ts";

export const MAX_TEMPLATE_FOLDERS = 100;
export const MAX_TEMPLATE_DEPTH = 5;

/** One template: who it is for and its folders as paths ("Contracts/Signed"). */
export interface FolderTemplate {
  teamId: string | null;
  engagementTypeId: string | null;
  folders: string[];
}

/**
 * A template's folders as they will be stored: one path per folder, parents
 * before the folders inside them, a parent added where only its child was typed.
 */
export function parseTemplateFolders(raw: unknown): { ok: true; folders: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "Folders must be a list." };
  // Keyed without case, as two folders side by side can't differ by case alone.
  const kept = new Map<string, string>();
  for (const line of raw) {
    if (typeof line !== "string") return { ok: false, error: "Folders must be a list of names." };
    if (!line.trim()) continue;
    const parts = line.split("/");
    if (parts.length > MAX_TEMPLATE_DEPTH) return { ok: false, error: `Folders can sit at most ${MAX_TEMPLATE_DEPTH} deep.` };
    let path = "";
    for (const part of parts) {
      const parsed = parseFolderName(part);
      if (!parsed.ok) return { ok: false, error: `"${line.trim()}": ${parsed.error}` };
      const typed = path ? `${path}/${parsed.name}` : parsed.name;
      // The spelling it was first given wins, so "contracts/Signed" joins "Contracts".
      path = kept.get(typed.toLowerCase()) ?? typed;
      kept.set(typed.toLowerCase(), path);
    }
  }
  if (kept.size > MAX_TEMPLATE_FOLDERS) return { ok: false, error: `A template can hold at most ${MAX_TEMPLATE_FOLDERS} folders.` };
  return { ok: true, folders: [...kept.values()] };
}

/**
 * The template a new engagement takes: the closest one. Its team and type,
 * then its team alone, then its type alone, then the one for any engagement.
 * A new client has neither, so it takes the one template clients have.
 */
export function pickTemplate<T extends FolderTemplate>(templates: T[], target: { teamId: string | null; engagementTypeId: string | null }): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const template of templates) {
    if (template.teamId && template.teamId !== target.teamId) continue;
    if (template.engagementTypeId && template.engagementTypeId !== target.engagementTypeId) continue;
    const score = (template.teamId ? 2 : 0) + (template.engagementTypeId ? 1 : 0);
    if (score > bestScore) {
      best = template;
      bestScore = score;
    }
  }
  return best;
}

/** The folder rows a template makes, each knowing the row it sits inside. */
export function templateRows(folders: string[], newId: () => string): { id: string; parentId: string | null; name: string }[] {
  const idOf = new Map<string, string>();
  return folders.map((path) => {
    const cut = path.lastIndexOf("/");
    const id = newId();
    idOf.set(path, id);
    return { id, parentId: cut < 0 ? null : (idOf.get(path.slice(0, cut)) ?? null), name: path.slice(cut + 1) };
  });
}
