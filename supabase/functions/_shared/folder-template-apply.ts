import type { ServiceClient } from "./service-client.ts";
import { pickTemplate, templateRows } from "./folder-templates.ts";

/**
 * Gives a new client or engagement the folders of its template. A failure is
 * logged and left: the record is real either way, and folders can be made by hand.
 */
export async function applyFolderTemplate(
  serviceClient: ServiceClient,
  record: "client" | "engagement",
  recordId: string,
  callerId: string,
  target: { teamId: string | null; engagementTypeId: string | null } = { teamId: null, engagementTypeId: null },
): Promise<void> {
  try {
    const { data, error } = await serviceClient
      .from("folder_templates")
      .select("team_id, engagement_type_id, folders")
      .eq("kind", record);
    if (error) throw error;
    const template = pickTemplate(
      (data ?? []).map((t) => ({
        teamId: typeof t.team_id === "string" ? t.team_id : null,
        engagementTypeId: typeof t.engagement_type_id === "string" ? t.engagement_type_id : null,
        folders: Array.isArray(t.folders) ? (t.folders as string[]) : [],
      })),
      target,
    );
    if (!template || template.folders.length === 0) return;
    // One insert: a folder and the folders inside it go in together.
    const rows = templateRows(template.folders, () => crypto.randomUUID()).map((row) => ({
      id: row.id,
      parent_id: row.parentId,
      name: row.name,
      [record === "client" ? "client_id" : "engagement_id"]: recordId,
      created_by: callerId,
    }));
    const { error: insertError } = await serviceClient.from("document_folders").insert(rows);
    if (insertError) throw insertError;
  } catch (error) {
    console.error("folder template", record, recordId, error);
  }
}
