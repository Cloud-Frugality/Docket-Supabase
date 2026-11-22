// The fields a document category asks for, and what a file answers. No
// database here, so the tests run this file.

export const FIELD_TYPES = ["text", "number", "date", "choice"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const MAX_CATEGORY_FIELDS = 12;
export const MAX_FIELD_LABEL = 60;
export const MAX_FIELD_VALUE = 200;
export const MAX_FIELD_CHOICES = 30;

/** One field of a category. `key` is what a file's answer is stored under, so it never changes. */
export interface CategoryField {
  key: string;
  label: string;
  type: FieldType;
  /** What a choice field offers; empty on the other types. */
  options: string[];
  required: boolean;
}

const KEY = /^[a-z0-9-]{1,40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (value: unknown) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");

/** A category's fields as sent, checked, or why they can't be saved. */
export function parseCategoryFields(raw: unknown): { ok: true; fields: CategoryField[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "Fields must be a list." };
  if (raw.length > MAX_CATEGORY_FIELDS) return { ok: false, error: `A category can have at most ${MAX_CATEGORY_FIELDS} fields.` };
  const fields: CategoryField[] = [];
  for (const item of raw) {
    const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key : "";
    if (!KEY.test(key)) return { ok: false, error: "A field is missing its key." };
    if (fields.some((f) => f.key === key)) return { ok: false, error: "Two fields share a key." };
    const label = text(row.label);
    if (!label) return { ok: false, error: "Give every field a name." };
    if (label.length > MAX_FIELD_LABEL) return { ok: false, error: `A field name can be at most ${MAX_FIELD_LABEL} characters.` };
    if (fields.some((f) => f.label.toLowerCase() === label.toLowerCase())) return { ok: false, error: `Two fields are named "${label}".` };
    const type = row.type as FieldType;
    if (!(FIELD_TYPES as readonly unknown[]).includes(type)) return { ok: false, error: `"${label}" needs a type.` };
    let options: string[] = [];
    if (type === "choice") {
      options = [...new Set((Array.isArray(row.options) ? row.options : []).map(text).filter(Boolean))];
      if (options.length === 0) return { ok: false, error: `"${label}" needs at least one choice.` };
      if (options.length > MAX_FIELD_CHOICES) return { ok: false, error: `"${label}" can offer at most ${MAX_FIELD_CHOICES} choices.` };
      if (options.some((o) => o.length > MAX_FIELD_VALUE)) return { ok: false, error: `A choice of "${label}" is too long.` };
    }
    fields.push({ key, label, type, options, required: row.required === true });
  }
  return { ok: true, fields };
}

/** What is stored may be older than these rules, so it is read forgivingly. */
export function storedFields(raw: unknown): CategoryField[] {
  const parsed = parseCategoryFields(raw);
  return parsed.ok ? parsed.fields : [];
}

/**
 * A file's answers to its category's fields, as sent. Only the category's own
 * fields are kept, so changing a file's category drops the old answers.
 */
export function parseCustomValues(
  fields: readonly CategoryField[],
  raw: unknown,
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  const sent = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = typeof sent[field.key] === "number" ? String(sent[field.key]) : text(sent[field.key]);
    if (!value) {
      if (field.required) return { ok: false, error: `${field.label} is required.` };
      continue;
    }
    if (value.length > MAX_FIELD_VALUE) return { ok: false, error: `${field.label} must be ${MAX_FIELD_VALUE} characters or fewer.` };
    if (field.type === "number" && !Number.isFinite(Number(value))) return { ok: false, error: `${field.label} must be a number.` };
    if (field.type === "date" && !(ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) {
      return { ok: false, error: `${field.label} must be a date.` };
    }
    if (field.type === "choice" && !field.options.includes(value)) {
      return { ok: false, error: `${field.label} must be one of: ${field.options.join(", ")}.` };
    }
    values[field.key] = value;
  }
  return { ok: true, values };
}
