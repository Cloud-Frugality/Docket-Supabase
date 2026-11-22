// What a document is, and who may remove it. Import-free so the tests run this
// file; the client mirrors the vocabularies in src/lib/document-types.ts
// (drift-tested). The types themselves are rows (document_categories). A Signed file is never removed, only superseded by a new
// version.

import { parseCustomValues, type CategoryField } from "./document-fields.ts";

/**
 * Whose removed files the recycle bin shows the caller. It follows who may
 * restore one: Documents delete at All sees every removed file, at Own only
 * their own uploads, and with neither the bin is closed. Reading at Own
 * narrows it the same way. Levels are 0 none, 1 own, 2 all.
 */
export function binScope(
  readLevel: number,
  deleteLevel: number,
  callerId: string,
): { ok: true; uploader: string | null } | { ok: false; error: string } {
  if (deleteLevel < 1) return { ok: false, error: "Only someone who can manage documents can open the recycle bin." };
  return { ok: true, uploader: readLevel >= 2 && deleteLevel >= 2 ? null : callerId };
}

export const MAX_BIN_DAYS = 3650;

/** How long the recycle bin keeps a removed file, as sent: whole days, or null to keep it until deleted by hand. */
export function parseBinDays(raw: unknown): { ok: true; days: number | null } | { ok: false; error: string } {
  if (raw === null || raw === "") return { ok: true, days: null };
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > MAX_BIN_DAYS) {
    return { ok: false, error: `The recycle bin keeps files for a whole number of days from 1 to ${MAX_BIN_DAYS}.` };
  }
  return { ok: true, days };
}

/** The moment before which a removed file has been in the bin too long. */
export function binCutoff(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** People as filter options, by name. One with no name left reads as Unknown. */
export function peopleOptions(ids: Iterable<string>, names: Map<string, string>): { id: string; name: string }[] {
  return [...new Set(ids)].map((id) => ({ id, name: names.get(id) ?? "Unknown" })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The records that carry files, as the document tables name them. */
export const DOCUMENT_RECORDS = ["engagement", "client", "feature_request"] as const;
export type DocumentRecord = (typeof DOCUMENT_RECORDS)[number];

/** What a feature request's attachment may be. Client and engagement files
 *  pick from the document categories instead (document-categories.ts). */
export const FEATURE_REQUEST_DOCUMENT_TYPES = ["Specification", "Screenshot", "Other"] as const;

/** The types a file on one record may be, and which of them are binding:
 *  those also take a reference (a PO or contract number) and effective dates. */
export interface AllowedTypes {
  types: readonly string[];
  binding: readonly string[];
  /** The fields each type asks for, by type name. Absent means none. */
  fields?: Record<string, CategoryField[]>;
}

/** Draft while being worked on, Final once settled, Signed once executed.
 *  Superseded and Expired are derived from versions and dates, never stored,
 *  so they can't disagree. */
export const DOCUMENT_STATUSES = ["Draft", "Final", "Signed"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const MAX_DOCUMENT_REFERENCE = 100;
export const MAX_DOCUMENT_NOTE = 500;

/** How long an uploader may remove their own file without the Documents
 *  delete grant: long enough to fix a wrong upload, short enough that a filed
 *  document isn't quietly withdrawn later. */
export const OWN_REMOVE_WINDOW_HOURS = 24;

export interface DocumentMetadata {
  documentType: string;
  status: DocumentStatus;
  reference: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  note: string | null;
  /** Its answers to its category's own fields, by field key. */
  custom: Record<string, string>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The metadata a caller sent, checked against the types its record allows. Reference
 * and dates only survive on a binding type, so switching to Other drops them.
 */
export function parseDocumentMetadata(
  allowed: AllowedTypes,
  raw: Record<string, unknown>,
): { ok: true; value: DocumentMetadata } | { ok: false; error: string } {
  const documentType = text(raw.documentType);
  if (!allowed.types.includes(documentType)) {
    return { ok: false, error: `documentType must be one of: ${allowed.types.join(", ")}.` };
  }
  const status = text(raw.status);
  if (!(DOCUMENT_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: `status must be one of: ${DOCUMENT_STATUSES.join(", ")}.` };
  }
  const note = text(raw.note);
  if (note.length > MAX_DOCUMENT_NOTE) {
    return { ok: false, error: `The note must be ${MAX_DOCUMENT_NOTE} characters or fewer.` };
  }

  const binding = allowed.binding.includes(documentType);
  const reference = binding ? text(raw.reference) : "";
  if (reference.length > MAX_DOCUMENT_REFERENCE) {
    return { ok: false, error: `The reference must be ${MAX_DOCUMENT_REFERENCE} characters or fewer.` };
  }
  const effectiveFrom = binding ? text(raw.effectiveFrom) : "";
  const effectiveTo = binding ? text(raw.effectiveTo) : "";
  if (effectiveFrom && !isIsoDate(effectiveFrom)) return { ok: false, error: "Invalid effectiveFrom." };
  if (effectiveTo && !isIsoDate(effectiveTo)) return { ok: false, error: "Invalid effectiveTo." };
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
    return { ok: false, error: "A document cannot stop being effective before it starts." };
  }

  const custom = parseCustomValues(allowed.fields?.[documentType] ?? [], raw.custom);
  if (!custom.ok) return { ok: false, error: custom.error };

  return {
    ok: true,
    value: {
      documentType,
      status: status as DocumentStatus,
      reference: reference || null,
      effectiveFrom: effectiveFrom || null,
      effectiveTo: effectiveTo || null,
      note: note || null,
      custom: custom.values,
    },
  };
}

/** Files uploaded before metadata existed count as Other and Final. */
export function legacyMetadata(): DocumentMetadata {
  return { documentType: "Other", status: "Final", reference: null, effectiveFrom: null, effectiveTo: null, note: null, custom: {} };
}

/**
 * Whether this caller may remove (archive) this file, and if not, why.
 *
 * - Signed: nobody. It's superseded by a new version instead.
 * - The Documents delete grant: any other file (at Own, only their uploads).
 * - Otherwise the uploader, for their own file while it's Draft or inside the
 *   window, so fixing a wrong upload doesn't need an administrator.
 */
export function removalRefusal(input: {
  status: string;
  uploadedBy: string | null;
  callerId: string;
  createdAt: string;
  now: Date;
  /** The caller's Documents delete level: 0 none, 1 Own, 2 All. */
  deleteLevel: number;
}): string | null {
  if (input.status === "Signed") {
    return "A signed document cannot be removed. Upload a new version instead.";
  }
  const isUploader = !!input.uploadedBy && input.uploadedBy === input.callerId;
  if (input.deleteLevel >= 2) return null;
  if (input.deleteLevel === 1 && isUploader) return null;
  if (isUploader) {
    const ageHours = (input.now.getTime() - Date.parse(input.createdAt)) / 3_600_000;
    if (input.status === "Draft" || ageHours <= OWN_REMOVE_WINDOW_HOURS) return null;
    return `Only a Draft, or a file uploaded in the last ${OWN_REMOVE_WINDOW_HOURS} hours, can be removed by the person who uploaded it. Ask someone who can manage documents.`;
  }
  return "Only the person who uploaded this file, or someone who can manage documents, can remove it.";
}
