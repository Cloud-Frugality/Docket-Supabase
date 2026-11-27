// Document rules shared by the engagement, client and feature request
// attachments. Import-free so the tests run this file; the handlers that touch
// the database are in document-handlers.ts.

import { DEFAULT_UPLOAD_RULES, uploadKindOf, uploadTypesPhrase, type UploadRules } from "./upload-rules.ts";

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

/**
 * null when the document is acceptable, else the message to send back.
 * `rules` is what the organisation allows: which kinds of file, and how big.
 */
export function validateDocument(
  doc: { fileName: string; contentType: string; sizeBytes: number },
  rules: UploadRules = DEFAULT_UPLOAD_RULES,
): string | null {
  if (!doc.fileName || !doc.fileName.trim()) return "A file name is required.";
  if (doc.fileName.length > 255) return "That file name is too long.";
  // The name is used as-is when the file is saved on someone's computer, so it must be one plain name.
  if (/[\\/:*?"<>|]/.test(doc.fileName) || [...doc.fileName].some((c) => c.charCodeAt(0) < 32)) {
    return 'That file name has a character that cannot be used (\\ / : * ? " < > |). Rename the file and try again.';
  }
  // Its kind comes from its name, and it has to be stored under that kind's own content type.
  const kind = uploadKindOf(doc.fileName);
  if (!kind || !rules.types.includes(kind.key) || kind.contentType !== doc.contentType) {
    return `That file type is not supported. Attach a ${uploadTypesPhrase(rules.types)} file.`;
  }
  if (!Number.isFinite(doc.sizeBytes) || doc.sizeBytes <= 0) return "That file is empty.";
  if (doc.sizeBytes > rules.maxMb * 1024 * 1024) return `That file is over the ${rules.maxMb}MB limit.`;
  return null;
}
