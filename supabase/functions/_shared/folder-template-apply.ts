import type { ServiceClient } from "./service-client.ts";
import { existingFolderPaths, pickTemplate, templateRows } from "./folder-templates.ts";

type Row = Record<string, unknown>;

/**
 * Gives a client or engagement the folders of its template, leaving the
 * folders it already has alone. Returns how many were made, or null when no
 * template fits it. Throws on a database error.
 */
export async function addTemplateFolders(
  serviceClient: ServiceClient,
  record: "client" | "engagement",
  recordId: string,
  callerId: string,
  target: { teamId: string | null; engagementTypeId: string | null },
): Promise<number | null> {
  const owner = record === "client" ? "client_id" : "engagement_id";
  const [templates, existing] = await Promise.all([
    serviceClient.from("folder_templates").select("team_id, engagement_type_id, folders").eq("kind", record),
    serviceClient.from("document_folders").select("id, parent_id, name").eq(owner, recordId),
  ]);
  if (templates.error ?? existing.error) throw templates.error ?? existing.error;
  const template = pickTemplate(
    ((templates.data ?? []) as Row[]).map((t) => ({
      teamId: typeof t.team_id === "string" ? t.team_id : null,
      engagementTypeId: typeof t.engagement_type_id === "string" ? t.engagement_type_id : null,
      folders: Array.isArray(t.folders) ? (t.folders as string[]) : [],
    })),
    target,
  );
  if (!template) return null;
  const have = existingFolderPaths(
    ((existing.data ?? []) as Row[]).map((f) => ({
      id: String(f.id),
      parentId: typeof f.parent_id === "string" ? f.parent_id : null,
      name: String(f.name),
    })),
  );
  // One insert: a folder and the folders inside it go in together.
  const rows = templateRows(template.folders, () => crypto.randomUUID(), have).map((row) => ({
    id: row.id,
    parent_id: row.parentId,
    name: row.name,
    [owner]: recordId,
    created_by: callerId,
  }));
  if (rows.length === 0) return 0;
  const { error } = await serviceClient.from("document_folders").insert(rows);
  if (error) throw error;
  return rows.length;
}

/**
 * The same for a record that has just been created. A failure is logged and
 * left: the record is real either way, and folders can be made by hand.
 */
export async function applyFolderTemplate(
  serviceClient: ServiceClient,
  record: "client" | "engagement",
  recordId: string,
  callerId: string,
  target: { teamId: string | null; engagementTypeId: string | null } = { teamId: null, engagementTypeId: null },
): Promise<void> {
  try {
    await addTemplateFolders(serviceClient, record, recordId, callerId, target);
  } catch (error) {
    console.error("folder template", record, recordId, error);
  }
}
