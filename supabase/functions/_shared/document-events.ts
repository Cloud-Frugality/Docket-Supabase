// What a file's history records. No database here; the client mirrors the
// labels in src/lib/document-types.ts (drift-tested).

export const DOCUMENT_EVENTS = [
  "uploaded",
  "version_added",
  "opened",
  "details_changed",
  "moved",
  "submitted",
  "approval_recorded",
  "approved",
  "sent_back",
  "hold_set",
  "hold_lifted",
  "access_changed",
  "removed",
  "restored",
  "deleted",
  "retention_extended",
  "disposed",
] as const;
export type DocumentEvent = (typeof DOCUMENT_EVENTS)[number];

export const MAX_EVENT_DETAIL = 300;
