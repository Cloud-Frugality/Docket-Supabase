// Document rules shared by the engagement, client and feature request
// attachments. Import-free so the tests run this file; the handlers that touch
// the database are in document-handlers.ts.

/** 20MB. A contract or a purchase order is a document, not a video. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/**
 * Attachments are documents only: contracts, POs and RFPs arrive as PDF, Word
 * or Excel.
 */
export const ALLOWED_DOCUMENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

/**
 * A file name made safe for a storage key: no separators, traversal or control
 * characters, and bounded. Anything not a letter, digit, dot, underscore or
 * hyphen becomes a hyphen. The original name is kept on the row for display.
 */
export function safeFileName(name: string): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "-")
    // No leading dots, so ".." and dotfiles both stop being interesting.
    .replace(/^\.+/, "")
    .replace(/-+/g, "-")
    .slice(0, 120);
  return cleaned || "document";
}

/** Object key inside an entity's document bucket (engagement-documents or
 *  client-documents), foldered per owning entity. */
export function documentStoragePath(entityId: string, unique: string, fileName: string): string {
  return `${entityId}/${unique}-${safeFileName(fileName)}`;
}

/** null when the document is acceptable, else the message to send back. */
export function validateDocument(doc: {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}): string | null {
  if (!doc.fileName || !doc.fileName.trim()) return "A file name is required.";
  if (doc.fileName.length > 255) return "That file name is too long.";
  if (!(ALLOWED_DOCUMENT_TYPES as readonly string[]).includes(doc.contentType)) {
    return "That file type is not supported. Attach a PDF, Word or Excel document.";
  }
  if (!Number.isFinite(doc.sizeBytes) || doc.sizeBytes <= 0) return "That file is empty.";
  if (doc.sizeBytes > MAX_DOCUMENT_BYTES) {
    return `That file is over the ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))}MB limit.`;
  }
  return null;
}
