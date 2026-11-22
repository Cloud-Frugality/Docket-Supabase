// Looks inside an uploaded file and refuses what should not be stored. No
// database here, so the tests run this file.
//
// This is not antivirus. It checks two things a name can't tell us: that the
// file really is the kind its name says, and that it carries none of the usual
// ways a document does harm when opened: macros, a PDF that runs scripts or
// launches programs, a program tucked inside an Office file, a template pulled
// from elsewhere, an object embedded in rich text. A file that can't be read
// well enough to check is refused too.
//
// Each check is the organisation's to switch off (UPLOAD_CHECKS, mirrored in
// src/lib/upload-checks.ts and drift-tested). A file is read for everything
// it has wrong with it, and refused for the first of those still switched on.

import { uploadKindOf } from "./upload-rules.ts";

/** What can be wrong with a file, worst first, and what the person is told. */
export const REFUSED = {
  mismatch: "This file's contents are not what its name says, so it was refused.",
  unreadable: "This file is damaged or can't be checked, so it was refused.",
  macros: "This file contains macros, which are not allowed. Save it without macros and upload it again.",
  pdfActive: "This PDF runs scripts or launches programs, which is not allowed.",
  program: "This file has a program inside it, which is not allowed.",
  template: "This file loads a template from somewhere else when it is opened, which is not allowed.",
  rtfObject: "This file has an embedded object, which is not allowed in rich text.",
  locked: "This file is password-protected, so it can't be checked. Remove the password and upload it again.",
} as const;
type Finding = keyof typeof REFUSED;

/** The checks an organisation can switch off, each with the findings it stands for. */
export const UPLOAD_CHECKS = ["contents", "macros", "pdf_scripts", "programs", "templates", "rtf_objects", "locked"] as const;
export type UploadCheck = (typeof UPLOAD_CHECKS)[number];

const CHECK_OF: Record<Finding, UploadCheck> = {
  mismatch: "contents",
  unreadable: "contents",
  macros: "macros",
  pdfActive: "pdf_scripts",
  program: "programs",
  template: "templates",
  rtfObject: "rtf_objects",
  locked: "locked",
};

/** The checks switched off, as stored or as sent: known ones only, each once. Null when it isn't a list. */
export function parseChecksOff(raw: unknown): UploadCheck[] | null {
  if (!Array.isArray(raw)) return null;
  return UPLOAD_CHECKS.filter((check) => raw.includes(check));
}

// ---------------------------------------------------------------- bytes

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const utf16 = (text: string) => Uint8Array.from([...text].flatMap((c) => [c.charCodeAt(0), 0]));

function matchesAt(hay: Uint8Array, needle: Uint8Array, at: number): boolean {
  if (at < 0 || at + needle.length > hay.length) return false;
  for (let i = 0; i < needle.length; i++) if (hay[at + i] !== needle[i]) return false;
  return true;
}

/** Where `needle` first is at or after `from`, before `end`; -1 when it isn't. */
function find(hay: Uint8Array, needle: Uint8Array, from = 0, end = hay.length): number {
  // The built-in search finds the first byte quickly; the rest is checked by hand.
  for (let at = hay.indexOf(needle[0], from); at >= 0 && at + needle.length <= end; at = hay.indexOf(needle[0], at + 1)) {
    if (matchesAt(hay, needle, at)) return at;
  }
  return -1;
}

const latin1 = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);
const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** Unpacks compressed bytes, up to a limit. Null when nothing could be read. */
async function inflate(data: Uint8Array, format: "deflate" | "deflate-raw", limit: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(format)).getReader();
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    if (total >= limit) await reader.cancel();
  } catch {
    // Bytes after the end of the data make it throw; what came out before still counts.
  }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------- zip (Office, OpenDocument)

interface ZipEntry {
  name: string;
  method: number;
  size: number;
  offset: number;
}

const PK_FILE = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
const PK_ENTRY = Uint8Array.from([0x50, 0x4b, 0x01, 0x02]);
const PK_END = Uint8Array.from([0x50, 0x4b, 0x05, 0x06]);

/** The files a zip lists, read from its directory. Null when it can't be read. */
function zipEntries(bytes: Uint8Array): ZipEntry[] | null {
  if (!matchesAt(bytes, PK_FILE, 0)) return null;
  // The directory's own record is at the very end, before an optional comment.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 66000); at--) {
    if (matchesAt(bytes, PK_END, at)) {
      end = at;
      break;
    }
  }
  if (end < 0) return null;
  const count = u16(bytes, end + 10);
  let at = u32(bytes, end + 16);
  // The larger zip format is not something an office document needs.
  if (count === 0xffff || at === 0xffffffff) return null;
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (!matchesAt(bytes, PK_ENTRY, at)) return null;
    const nameLength = u16(bytes, at + 28);
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      method: u16(bytes, at + 10),
      size: u32(bytes, at + 20),
      offset: u32(bytes, at + 42),
    });
    at += 46 + nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
  }
  return entries;
}

/** One small file out of a zip, as text. Null when it can't be read. */
async function zipText(bytes: Uint8Array, entry: ZipEntry): Promise<string | null> {
  if (!matchesAt(bytes, PK_FILE, entry.offset)) return null;
  const start = entry.offset + 30 + u16(bytes, entry.offset + 26) + u16(bytes, entry.offset + 28);
  const data = bytes.subarray(start, start + entry.size);
  if (entry.method === 0) return latin1(data);
  if (entry.method !== 8) return null;
  const out = await inflate(data, "deflate-raw", 1024 * 1024);
  return out ? latin1(out) : null;
}

// What runs when double-clicked, wherever it is inside a document.
const PROGRAM = /\.(exe|dll|scr|com|bat|cmd|ps1|vbs|vbe|js|jse|wsf|hta|jar|msi|lnk)$/i;

// The folder an Office file keeps its main part in, by the end of its name.
const OFFICE_FOLDER: Record<string, string> = { docx: "word/", xlsx: "xl/", pptx: "ppt/", vsdx: "visio/" };

// The header of the older Office container, and what one holding a locked file calls it.
const OLE = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ENCRYPTED_PACKAGE = utf16("EncryptedPackage");

async function inspectZip(bytes: Uint8Array, ending: string): Promise<Finding[]> {
  const entries = zipEntries(bytes);
  // A password-protected Office file is not a zip at all: it is the older container with the locked file inside.
  if (!entries) return [matchesAt(bytes, OLE, 0) && find(bytes, ENCRYPTED_PACKAGE) >= 0 ? "locked" : "mismatch"];
  const names = entries.map((e) => e.name);
  const found: Finding[] = [];
  const office = OFFICE_FOLDER[ending];
  if (office) {
    if (!names.includes("[Content_Types].xml") || !names.some((n) => n.startsWith(office))) return ["mismatch"];
    if (names.some((n) => /vbaProject|vbaData/i.test(n))) found.push("macros");
  } else {
    // OpenDocument: says what it is in a file called mimetype, and keeps macros in Basic or Scripts.
    if (!names.includes("mimetype") || !names.includes("content.xml")) return ["mismatch"];
    if (names.some((n) => n.startsWith("Basic/") || n.startsWith("Scripts/"))) found.push("macros");
  }
  if (names.some((n) => PROGRAM.test(n))) found.push("program");
  // A Word file can name a template to fetch as it opens, which is how a
  // clean-looking file brings macros in. Only one fetched over a network
  // counts: most documents name a template on the author's own disk, which
  // does nothing anywhere else.
  const settings = entries.find((e) => e.name === "word/_rels/settings.xml.rels");
  if (settings) {
    const text = await zipText(bytes, settings);
    if (text === null) found.push("unreadable");
    for (const relationship of text?.match(/<Relationship\b[^>]*>/gi) ?? []) {
      const target = /\bTarget\s*=\s*["']([^"']*)["']/i.exec(relationship)?.[1] ?? "";
      if (/attachedTemplate/i.test(relationship) && /^(https?:|ftp:|\\\\|file:\/\/[^/])/i.test(target.trim())) found.push("template");
    }
  }
  return found;
}

// ---------------------------------------------------------------- older Office (doc, xls, ppt, vsd, mpp, msg)

// How a macro project is named in the file's own directory, which is in
// two-byte characters. Every one has this stream, and ordinary writing never
// spells it.
const VBA_PROJECT = utf16("_VBA_PROJECT");

function inspectOle(bytes: Uint8Array): Finding[] {
  if (!matchesAt(bytes, OLE, 0)) return ["mismatch"];
  return find(bytes, VBA_PROJECT) >= 0 ? ["macros"] : [];
}

// ---------------------------------------------------------------- PDF

const PDF_START = ascii("%PDF-");
const STREAM = ascii("stream");
const END_STREAM = ascii("endstream");
const OBJ_STREAM = ascii("/ObjStm");
const FLATE = ascii("/FlateDecode");
// The most one PDF's packed objects may unpack to, all told.
const PDF_UNPACK_LIMIT = 64 * 1024 * 1024;

const PDF_NAME_END = new Set([0, 9, 10, 12, 13, 32, 37, 40, 41, 47, 60, 62, 91, 93, 123, 125]);

/** The names (/Like /This) between two points, with #xx escapes read as the characters they stand for. */
function pdfNames(bytes: Uint8Array, from: number, end: number, into: Set<string>): void {
  for (let at = bytes.indexOf(0x2f, from); at >= 0 && at < end; at = bytes.indexOf(0x2f, at + 1)) {
    let name = "";
    for (let i = at + 1; i < end && name.length < 16 && !PDF_NAME_END.has(bytes[i]); i++) {
      if (bytes[i] === 0x23 && i + 2 < end) {
        const code = Number.parseInt(String.fromCharCode(bytes[i + 1], bytes[i + 2]), 16);
        if (!Number.isNaN(code)) {
          name += String.fromCharCode(code);
          i += 2;
          continue;
        }
      }
      name += String.fromCharCode(bytes[i]);
    }
    into.add(name);
  }
}

async function inspectPdf(bytes: Uint8Array): Promise<Finding[]> {
  if (find(bytes, PDF_START, 0, Math.min(bytes.length, 1024)) < 0) return ["mismatch"];
  const names = new Set<string>();
  let unpacked = 0;
  // Set when some of its packed objects could not be opened to look inside.
  let sealed = false;
  // Names are only read outside the streams, whose bytes are images and fonts
  // and would give false alarms. The one kind of stream that holds objects is
  // unpacked and read too.
  let at = 0;
  while (at < bytes.length) {
    let stream = find(bytes, STREAM, at);
    // "endstream" holds the word too; a stream starts with it on a line of its own.
    while (stream >= 0 && !(bytes[stream + 6] === 10 || (bytes[stream + 6] === 13 && bytes[stream + 7] === 10))) {
      stream = find(bytes, STREAM, stream + 1);
    }
    const until = stream < 0 ? bytes.length : stream;
    pdfNames(bytes, at, until, names);
    if (stream < 0) break;
    const start = stream + (bytes[stream + 6] === 13 ? 8 : 7);
    const stop = find(bytes, END_STREAM, start);
    if (stop < 0) return ["unreadable"];
    // What kind of stream it is, from the few lines before it.
    const before = Math.max(at, stream - 2048);
    if (find(bytes, OBJ_STREAM, before, stream) >= 0) {
      const objects = find(bytes, FLATE, before, stream) < 0 || unpacked >= PDF_UNPACK_LIMIT
        ? null
        : await inflate(bytes.subarray(start, stop), "deflate", PDF_UNPACK_LIMIT - unpacked);
      if (objects) {
        unpacked += objects.length;
        pdfNames(objects, 0, objects.length, names);
      } else {
        sealed = true;
      }
    }
    at = stop + END_STREAM.length;
  }
  const found: Finding[] = [];
  // Packed objects that won't open are how a password-protected PDF looks. In one that isn't, they mean damage.
  if (names.has("Encrypt")) found.push("locked");
  else if (sealed) found.push("unreadable");
  if (names.has("JavaScript") || names.has("JS") || names.has("Launch")) found.push("pdfActive");
  return found;
}

// ---------------------------------------------------------------- the rest

const startsWith = (bytes: Uint8Array, ...signature: number[]) => matchesAt(bytes, Uint8Array.from(signature), 0);

/** Plain text has no zero bytes, unless it is the two-byte kind, which says so in its first two. */
function looksLikeText(bytes: Uint8Array): boolean {
  if (startsWith(bytes, 0xff, 0xfe) || startsWith(bytes, 0xfe, 0xff)) return true;
  return bytes.subarray(0, 8192).indexOf(0) < 0;
}

const head = (bytes: Uint8Array, length = 4096) => latin1(bytes.subarray(0, length));

/** Everything wrong with a file, whatever the organisation has switched off. */
async function findings(bytes: Uint8Array, fileName: string): Promise<Finding[]> {
  const ending = fileName.slice(fileName.lastIndexOf(".") + 1).trim().toLowerCase();
  if (!uploadKindOf(fileName)) return ["mismatch"];
  const unless = (ok: boolean): Finding[] => (ok ? [] : ["mismatch"]);
  switch (ending) {
    case "pdf":
      return inspectPdf(bytes);
    case "docx":
    case "xlsx":
    case "pptx":
    case "vsdx":
    case "odt":
    case "ods":
    case "odp":
      return inspectZip(bytes, ending);
    case "doc":
    case "xls":
    case "ppt":
    case "vsd":
    case "mpp":
    case "msg":
      return inspectOle(bytes);
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "tif":
    case "tiff":
      // Any picture under any picture's name: a PNG saved as .jpg is common and does no harm.
      return unless(
        startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) ||
          startsWith(bytes, 0xff, 0xd8, 0xff) ||
          /^GIF8[79]a/.test(head(bytes, 6)) ||
          (head(bytes, 4) === "RIFF" && latin1(bytes.subarray(8, 12)) === "WEBP") ||
          startsWith(bytes, 0x49, 0x49, 0x2a, 0x00) ||
          startsWith(bytes, 0x4d, 0x4d, 0x00, 0x2a),
      );
    case "rtf":
      if (!head(bytes, 5).startsWith("{\\rtf")) return ["mismatch"];
      // Embedded objects are how rich text has carried attacks; ordinary letters and reports have none.
      return find(bytes, ascii("\\objdata")) >= 0 || find(bytes, ascii("\\objemb")) >= 0 ? ["rtfObject"] : [];
    case "drawio":
      return unless(looksLikeText(bytes) && /<mxfile|<mxGraphModel/.test(head(bytes)));
    case "eml":
      return unless(
        looksLikeText(bytes) && /^(From|Received|Return-Path|Delivered-To|MIME-Version|Date|Subject|Message-ID|To|X-[\w-]+):/im.test(head(bytes)),
      );
    default:
      // Text, CSV, Markdown, JSON and XML: anything, as long as it is text.
      return unless(looksLikeText(bytes));
  }
}

/**
 * Why this file can't be stored, or null when nothing the organisation checks
 * for is wrong with it. `fileName` says what kind it claims to be; `off` is
 * the checks switched off.
 */
export async function inspectFile(bytes: Uint8Array, fileName: string, off: readonly string[] = []): Promise<string | null> {
  const found = await findings(bytes, fileName);
  const first = (Object.keys(REFUSED) as Finding[]).find((finding) => found.includes(finding) && !off.includes(CHECK_OF[finding]));
  return first ? REFUSED[first] : null;
}
