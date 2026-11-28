// What may be uploaded: the kinds of file the organisation allows and how big
// one may be. Import-free so the tests run this file; the client mirrors the
// list in the Windows app.
//
// A global admin picks from the kinds below and sets the size, up to the
// ceiling. The storage buckets are set to the same limits when it is saved,
// so they stay the hard wall behind these checks.
//
// A file's kind is read from the end of its name, not from the content type a
// browser reports: browsers give a Visio or draw.io file no type at all, or a
// different one from machine to machine. Each ending has the one content type
// the file is stored under.

/** Every kind of file that can be allowed. Nothing that runs, and no archives. */
export const UPLOAD_FILE_TYPES = [
  { key: "pdf", label: "PDF", files: { pdf: "application/pdf" } },
  {
    key: "word",
    label: "Word",
    files: { doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  },
  {
    key: "excel",
    label: "Excel",
    files: { xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  },
  {
    key: "powerpoint",
    label: "PowerPoint",
    files: { ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  },
  {
    key: "opendocument",
    label: "OpenDocument",
    files: {
      odt: "application/vnd.oasis.opendocument.text",
      ods: "application/vnd.oasis.opendocument.spreadsheet",
      odp: "application/vnd.oasis.opendocument.presentation",
    },
  },
  { key: "richtext", label: "Rich Text and Markdown", files: { rtf: "application/rtf", md: "text/markdown" } },
  { key: "visio", label: "Visio", files: { vsd: "application/vnd.visio", vsdx: "application/vnd.ms-visio.drawing" } },
  { key: "drawio", label: "Draw.io", files: { drawio: "application/vnd.jgraph.mxfile" } },
  { key: "project", label: "Project", files: { mpp: "application/vnd.ms-project" } },
  { key: "email", label: "Email", files: { msg: "application/vnd.ms-outlook", eml: "message/rfc822" } },
  {
    key: "image",
    label: "Images",
    files: { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff" },
  },
  { key: "text", label: "Text and CSV", files: { txt: "text/plain", csv: "text/csv" } },
  { key: "data", label: "Data Files", files: { json: "application/json", xml: "application/xml" } },
] as const;

/** The most a single file can ever be, whatever the organisation picks. */
export const UPLOAD_MAX_MB_CEILING = 50;

export const DEFAULT_UPLOAD_TYPES = ["pdf", "word", "excel"];
export const DEFAULT_UPLOAD_MAX_MB = 25;

export interface UploadRules {
  /** Keys of UPLOAD_FILE_TYPES. */
  types: string[];
  maxMb: number;
}

export const DEFAULT_UPLOAD_RULES: UploadRules = { types: DEFAULT_UPLOAD_TYPES, maxMb: DEFAULT_UPLOAD_MAX_MB };

/**
 * The kind a file is and the content type it is stored under, from the end
 * of its name. Null when its name ends in nothing that can be allowed.
 */
export function uploadKindOf(fileName: string): { key: string; contentType: string } | null {
  const dot = fileName.lastIndexOf(".");
  const ending = dot < 0 ? "" : fileName.slice(dot + 1).trim().toLowerCase();
  for (const type of UPLOAD_FILE_TYPES) {
    const contentType = (type.files as Record<string, string>)[ending];
    if (contentType) return { key: type.key, contentType };
  }
  return null;
}

/** The content types the kinds picked are stored under, each once. */
export function uploadMimeTypes(types: readonly string[]): string[] {
  return [...new Set(UPLOAD_FILE_TYPES.filter((t) => types.includes(t.key)).flatMap((t) => Object.values(t.files) as string[]))];
}

/** The kinds picked as a phrase: "PDF, Word or Excel". */
export function uploadTypesPhrase(types: readonly string[]): string {
  const labels: string[] = UPLOAD_FILE_TYPES.filter((t) => types.includes(t.key)).map((t) => t.label);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}` : (labels[0] ?? "");
}

/** The rules as stored, falling back to the defaults for anything unreadable. */
export function storedUploadRules(types: unknown, maxMb: unknown): UploadRules {
  const known = Array.isArray(types) ? UPLOAD_FILE_TYPES.map((t) => t.key as string).filter((key) => types.includes(key)) : [];
  const mb = Number(maxMb);
  return {
    types: known.length > 0 ? known : DEFAULT_UPLOAD_TYPES,
    maxMb: Number.isInteger(mb) && mb >= 1 && mb <= UPLOAD_MAX_MB_CEILING ? mb : DEFAULT_UPLOAD_MAX_MB,
  };
}

/** The rules as sent: at least one known kind, and a whole number of MB up to the ceiling. */
export function parseUploadRules(types: unknown, maxMb: unknown): { ok: true; rules: UploadRules } | { ok: false; error: string } {
  if (!Array.isArray(types) || types.some((t) => typeof t !== "string")) return { ok: false, error: "The file types must be a list." };
  const unknown = types.find((t) => !UPLOAD_FILE_TYPES.some((known) => known.key === t));
  if (unknown !== undefined) return { ok: false, error: `${unknown} is not a file type that can be allowed.` };
  if (types.length === 0) return { ok: false, error: "Allow at least one file type." };
  const mb = Number(maxMb);
  if (!Number.isInteger(mb) || mb < 1 || mb > UPLOAD_MAX_MB_CEILING) {
    return { ok: false, error: `The largest file is a whole number of MB from 1 to ${UPLOAD_MAX_MB_CEILING}.` };
  }
  // In the list's own order, each once.
  return { ok: true, rules: { types: UPLOAD_FILE_TYPES.map((t) => t.key as string).filter((key) => types.includes(key)), maxMb: mb } };
}
