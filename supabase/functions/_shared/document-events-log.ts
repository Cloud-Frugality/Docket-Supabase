import type { ServiceClient } from "./service-client.ts";
import { MAX_EVENT_DETAIL, type DocumentEvent } from "./document-events.ts";

/**
 * Adds one line to a file's history. What happened has already happened, so a
 * failure here is logged and never undoes it. `actorId` is null for the
 * nightly clean-up.
 */
export async function logDocumentEvent(
  serviceClient: ServiceClient,
  // A row with record, id, family_id and file_name, as a document table or the register has it.
  file: Record<string, unknown>,
  action: DocumentEvent,
  actorId: string | null,
  detail: string | null = null,
): Promise<void> {
  // Feature request attachments keep no history.
  if (file.record !== "client" && file.record !== "engagement") return;
  try {
    const { error } = await serviceClient.from("document_events").insert({
      record: file.record,
      document_id: file.id,
      family_id: file.family_id,
      file_name: String(file.file_name ?? ""),
      action,
      actor: actorId,
      detail: detail ? detail.slice(0, MAX_EVENT_DETAIL) : null,
    });
    if (error) throw error;
  } catch (error) {
    console.error("document history", action, error);
  }
}
