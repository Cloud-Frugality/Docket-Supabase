// Document handlers shared by the engagement, client and feature request
// functions; each supplies its table, bucket and access gate.
//
// The bytes never pass through the function: upload_url mints a signed upload
// URL after the checks, the browser uploads straight to storage, then register
// writes the row. The buckets enforce size and type limits themselves; the
// checks here are for friendly messages. Remove archives; rules live in
// document-rules.ts. A held or retained file is neither removed nor erased
// (file-approval.ts), and the database refuses the delete as well.
import { internalError, jsonResponse } from "./http.ts";
import { isUuid } from "./validation.ts";
import { documentStoragePath, validateDocument } from "./documents.ts";
import { storedUploadRules, type UploadRules } from "./upload-rules.ts";
import { inspectFile, parseChecksOff } from "./file-inspection.ts";
import { buildDisplayNameMap } from "./display-names.ts";
import { callerLevel, LEVEL_ALL, LEVEL_OWN } from "./permissions.ts";
import { fileNameClash, legacyMetadata, parseDocumentMetadata, removalRefusal, SAME_FILE_NAME, type DocumentRecord } from "./document-rules.ts";
import { retentionRefusal } from "./file-approval.ts";
import { allowedDocumentTypes } from "./document-categories.ts";
import { appToday } from "./app-date.ts";
import { loadOrgLocale } from "./organisation-locale.ts";
import type { ServiceClient } from "./service-client.ts";
import { fileCanEdit, fileSeen, placeFor, registerFor } from "./document-access-load.ts";
import { VIEW_ONLY } from "./document-access.ts";
import { selectAllRows } from "./paging.ts";
import { logDocumentEvent } from "./document-events-log.ts";

export interface DocumentAccessDenial {
  error: string;
  status: number;
}

export interface DocumentEntityConfig {
  /** e.g. "engagement_documents" */
  table: string;
  /** e.g. "engagement_id" */
  idColumn: string;
  /** e.g. "engagement-documents" */
  bucket: string;
  /** Which type list the record's files choose from (document-rules.ts). */
  record: DocumentRecord;
  /** How the entity reads in messages ("engagement", "client"). */
  entityLabel: string;
  /**
   * The access gate from the calling function: null to proceed, else the
   * refusal. "read" gates list/download, "write" gates upload/register/edit.
   * Own-level ownership and the archived-parent guard live here so no handler
   * can skip them.
   */
  checkAccess: (entityId: string, intent: "read" | "write") => Promise<DocumentAccessDenial | null>;
}

export interface DocumentHandlerContext {
  serviceClient: ServiceClient;
  callerId: string;
}

const DOCUMENT_COLUMNS =
  "id, file_name, content_type, size_bytes, storage_path, uploaded_by, created_at, document_type, status, reference, effective_from, effective_to, note, family_id, version, archived_at";
// Client and engagement files are approved, held and retained; a feature
// request's attachments are not.
const APPROVAL_COLUMNS = ", approval_state, on_hold, retain_until, folder_id, restricted, custom";
const columnsFor = (cfg: Pick<DocumentEntityConfig, "record">) =>
  cfg.record === "feature_request" ? DOCUMENT_COLUMNS : DOCUMENT_COLUMNS + APPROVAL_COLUMNS;
// The register has every column the list needs but the storage path.
const LIST_COLUMNS = (DOCUMENT_COLUMNS + APPROVAL_COLUMNS).replace(" storage_path,", "");

/**
 * Whether another file already has this name where one would go (a record, and
 * a folder or none). Names are compared on each family's latest live version,
 * ignoring case; `familyId` is the file being named, which doesn't clash with
 * itself. Every file counts, seen or not, since the name is the place's.
 */
export async function fileNameTaken(
  serviceClient: ServiceClient,
  cfg: Pick<DocumentEntityConfig, "table" | "idColumn">,
  entityId: string,
  folderId: string | null,
  name: string,
  familyId: string | null,
): Promise<boolean> {
  const { data, error } = await selectAllRows(() => {
    const q = serviceClient.from(cfg.table).select("id, family_id, file_name, version").eq(cfg.idColumn, entityId).is("archived_at", null);
    return (folderId ? q.eq("folder_id", folderId) : q.is("folder_id", null)).order("id");
  });
  if (error) throw error;
  return fileNameClash(
    data.map((f) => ({ familyId: String(f.family_id), fileName: String(f.file_name), version: Number(f.version ?? 1) })),
    name,
    familyId,
  );
}

/** Today in the organisation's zone, which is what a retention date is read against. */
async function orgToday(serviceClient: ServiceClient): Promise<string> {
  return appToday(new Date(), (await loadOrgLocale(serviceClient)).timeZone);
}

const heldOrRetained = (row: Record<string, unknown>, today: string) =>
  retentionRefusal({ onHold: row.on_hold === true, retainUntil: typeof row.retain_until === "string" ? row.retain_until : null }, today);

type DocumentRow = Record<string, unknown> & {
  id: string;
  file_name: string;
  storage_path: string;
  uploaded_by: string | null;
  created_at: string;
  status: string;
  family_id: string;
  version: number;
  archived_at: string | null;
};

/** The caller's Documents delete level, and whether it lets them manage this
 *  removed file (restore it, or erase it): All, or Own on their own upload. */
async function documentsDeleteLevel(ctx: DocumentHandlerContext): Promise<number> {
  return callerLevel(ctx.serviceClient, ctx.callerId, "Documents", "delete");
}

function mayManageRemoved(level: number, uploadedBy: string | null, callerId: string): boolean {
  return level >= LEVEL_ALL || (level === LEVEL_OWN && !!uploadedBy && uploadedBy === callerId);
}

async function readDocument(
  ctx: DocumentHandlerContext,
  cfg: DocumentEntityConfig,
  documentId: string,
): Promise<{ doc: DocumentRow | null; error: unknown }> {
  const { data, error } = await ctx.serviceClient
    .from(cfg.table)
    .select(`${columnsFor(cfg)}, ${cfg.idColumn}`)
    .eq("id", documentId)
    .maybeSingle();
  if (error || !data) return { doc: null, error };
  // A file the caller doesn't see reads as not there, for every handler below.
  if (cfg.record !== "feature_request") {
    try {
      if (!(await fileSeen(ctx.serviceClient, ctx.callerId, cfg.record, documentId))) return { doc: null, error: null };
    } catch (seenError) {
      return { doc: null, error: seenError };
    }
  }
  return { doc: data as DocumentRow, error: null };
}

/**
 * Why the caller can't change this file, or null. A client's or engagement's
 * file follows file_can_edit (a lock, Can view and Can edit); the record checks
 * still run beside it.
 */
async function fileEditRefusal(ctx: DocumentHandlerContext, cfg: DocumentEntityConfig, doc: DocumentRow): Promise<DocumentAccessDenial | null> {
  if (cfg.record === "feature_request") return null;
  try {
    if (await fileCanEdit(ctx.serviceClient, ctx.callerId, cfg.record, doc.family_id)) return null;
  } catch (error) {
    console.error("file access:", (error as { message?: string }).message ?? error);
    return { error: "Unable to read the file's access.", status: 500 };
  }
  return { error: VIEW_ONLY, status: 403 };
}

/** The file as its history names it. */
const historyOf = (cfg: Pick<DocumentEntityConfig, "record">, doc: Record<string, unknown>) => ({
  record: cfg.record,
  id: doc.id,
  family_id: doc.family_id,
  file_name: doc.file_name,
});

/** GET ?entityId= every file on the record, newest first, removed ones
 *  included and flagged. Each row says whether this caller may remove it, so
 *  the screen never offers a button the server will refuse. */
export async function handleListDocuments(
  ctx: DocumentHandlerContext,
  cfg: DocumentEntityConfig,
  request: Request,
  entityIdRaw: string,
): Promise<Response> {
  const entityId = entityIdRaw.trim();
  if (!isUuid(entityId)) {
    // The wire name of the parent id (engagement_id -> engagementId).
    const wireName = cfg.idColumn.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
    return jsonResponse({ error: `Invalid ${wireName}.` }, request, 400);
  }

  const denied = await cfg.checkAccess(entityId, "read");
  if (denied) return jsonResponse({ error: denied.error }, request, denied.status);

  // A client's or engagement's files are the ones the caller sees, through the register.
  const { data, error } = cfg.record === "feature_request"
    ? await ctx.serviceClient.from(cfg.table).select(columnsFor(cfg)).eq(cfg.idColumn, entityId).order("created_at", { ascending: false })
    : await registerFor(ctx.serviceClient, ctx.callerId, LIST_COLUMNS)
      .eq("record", cfg.record)
      .eq("record_id", entityId)
      .order("created_at", { ascending: false })
      .order("id");

  if (error) return internalError(request, error, `list ${cfg.entityLabel} documents`);

  const rows = (data ?? []) as unknown as DocumentRow[];
  const uploaderIds = new Set(
    rows.map((r) => r.uploaded_by).filter((id): id is string => typeof id === "string" && !!id),
  );
  const [displayNameById, deleteLevel, today] = await Promise.all([
    buildDisplayNameMap(ctx.serviceClient, uploaderIds),
    documentsDeleteLevel(ctx),
    orgToday(ctx.serviceClient),
  ]);
  const now = new Date();

  return jsonResponse(
    {
      documents: rows.map((row) => {
        // A hold or a retention period comes first: nobody removes those.
        const refusal = row.archived_at
          ? null
          : heldOrRetained(row, today) ?? removalRefusal({
            status: row.status,
            uploadedBy: row.uploaded_by,
            callerId: ctx.callerId,
            createdAt: row.created_at,
            now,
            deleteLevel,
          });
        return {
          id: row.id,
          entityId,
          fileName: row.file_name,
          contentType: row.content_type,
          sizeBytes: Number(row.size_bytes ?? 0),
          uploadedByDisplayName: typeof row.uploaded_by === "string"
            ? (displayNameById.get(row.uploaded_by) ?? "Unknown")
            : "Unknown",
          createdAtUtc: typeof row.created_at === "string" ? row.created_at : "",
          documentType: row.document_type,
          status: row.status,
          reference: row.reference ?? null,
          effectiveFrom: row.effective_from ?? null,
          effectiveTo: row.effective_to ?? null,
          note: row.note ?? null,
          custom: row.custom && typeof row.custom === "object" ? row.custom : {},
          restricted: row.restricted === true,
          familyId: row.family_id,
          version: Number(row.version ?? 1),
          archivedAtUtc: row.archived_at,
          approvalState: row.approval_state ?? "none",
          onHold: row.on_hold === true,
          retainUntil: row.retain_until ?? null,
          canRemove: !row.archived_at && refusal === null,
          removeRefusal: refusal,
          canManageRemoved: !!row.archived_at && mayManageRemoved(deleteLevel, row.uploaded_by, ctx.callerId),
        };
      }),
    },
    request,
  );
}

/** GET ?documentId= a signed URL rather than the bytes. It expires in a
 *  minute so it can't be shared onward. */
export async function handleDocumentUrl(
  ctx: DocumentHandlerContext,
  cfg: DocumentEntityConfig,
  request: Request,
  documentIdRaw: string,
): Promise<Response> {
  const documentId = documentIdRaw.trim();
  if (!isUuid(documentId)) {
    return jsonResponse({ error: "Invalid documentId." }, request, 400);
  }

  const { doc, error } = await readDocument(ctx, cfg, documentId);
  if (error) return internalError(request, error, `read ${cfg.entityLabel} document`);
  if (!doc) return jsonResponse({ error: "Document not found." }, request, 404);

  // Gate on the parent, not the child id, so a guessed documentId can't read
  // around an Own-level grant.
  const denied = await cfg.checkAccess(String(doc[cfg.idColumn]), "read");
  if (denied) return jsonResponse({ error: denied.error }, request, denied.status);

  const { data: signed, error: signError } = await ctx.serviceClient
    .storage
    .from(cfg.bucket)
    .createSignedUrl(doc.storage_path, 60, { download: doc.file_name });

  if (signError || !signed?.signedUrl) {
    return internalError(request, signError, `sign ${cfg.entityLabel} document`);
  }
  await logDocumentEvent(ctx.serviceClient, historyOf(cfg, doc), "opened", ctx.callerId);
  return jsonResponse({ url: signed.signedUrl, fileName: doc.file_name }, request);
}

/**
 * The kinds of file and the size the organisation allows, and the checks on
 * an upload it has switched off. Read on each upload, so a change takes hold
 * at once.
 */
async function uploadRules(serviceClient: ServiceClient): Promise<UploadRules & { checksOff: string[] }> {
  const { data, error } = await serviceClient
    .from("organisations").select("upload_types, upload_max_mb, upload_checks_off").order("created_at").limit(1).maybeSingle();
  if (error) throw error;
  return { ...storedUploadRules(data?.upload_types, data?.upload_max_mb), checksOff: parseChecksOff(data?.upload_checks_off) ?? [] };
}

/** POST { entityId, fileName, contentType, sizeBytes }: validates, then mints
 *  a signed upload URL so the bytes go straight to storage. */
export async function handleDocumentUploadUrl(
  ctx: DocumentHandlerContext,
  cfg: DocumentEntityConfig,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const entityId = typeof payload.entityId === "string" ? payload.entityId.trim() : "";
  const fileName = typeof payload.fileName === "string" ? payload.fileName.trim() : "";
  const contentType = typeof payload.contentType === "string" ? payload.contentType.trim() : "";
  const sizeBytes = Number(payload.sizeBytes ?? 0);

  if (!isUuid(entityId)) {
    return jsonResponse({ error: "Invalid entityId." }, request, 400);
  }

  const invalid = validateDocument({ fileName, contentType, sizeBytes }, await uploadRules(ctx.serviceClient));
  if (invalid) return jsonResponse({ error: invalid }, request, 400);

  const denied = await cfg.checkAccess(entityId, "write");
  if (denied) return jsonResponse({ error: denied.error }, request, denied.status);

  const path = documentStoragePath(entityId, crypto.randomUUID(), fileName);
  const { data: signed, error: signError } = await ctx.serviceClient
    .storage
    .from(cfg.bucket)
    .createSignedUploadUrl(path);

  if (signError || !signed?.token) {
    return internalError(request, signError, `sign ${cfg.entityLabel} document upload`);
  }

  return jsonResponse({ path, token: signed.token }, request);
}

/** POST { entityId, path, fileName, contentType, sizeBytes, metadata,
 *  versionOf? }: after the browser's upload, check the object landed and write
 *  the row. `versionOf` names any version of a file on the same record; the
 *  upload becomes its next version. */
export async function handleRegisterDocument(
  ctx: DocumentHandlerContext,
  cfg: DocumentEntityConfig,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const { serviceClient, callerId } = ctx;
  const entityId = typeof payload.entityId === "string" ? payload.entityId.trim() : "";
  const path = typeof payload.path === "string" ? payload.path.trim() : "";
  const fileName = typeof payload.fileName === "string" ? payload.fileName.trim() : "";
  const contentType = typeof payload.contentType === "string" ? payload.contentType.trim() : "";
  const claimedSize = Number(payload.sizeBytes ?? 0);
  const versionOf = typeof payload.versionOf === "string" ? payload.versionOf.trim() : "";

  if (!isUuid(entityId)) {
    return jsonResponse({ error: "Invalid entityId." }, request, 400);
  }
  // The path must sit in this entity's folder, so a register call can't claim an
  // object uploaded for another record.
  if (!path.startsWith(`${entityId}/`) || path.includes("..")) {
    return jsonResponse({ error: "That upload does not belong to this record." }, request, 400);
  }
  if (versionOf && !isUuid(versionOf)) {
    return jsonResponse({ error: "Invalid versionOf." }, request, 400);
  }

  const rules = await uploadRules(serviceClient);
  const invalid = validateDocument({ fileName, contentType, sizeBytes: claimedSize }, rules);
  if (invalid) return jsonResponse({ error: invalid }, request, 400);

  // No details sent: file it as Other / Final so older callers still upload.
  const metadata = payload.metadata === undefined
    ? { ok: true as const, value: legacyMetadata() }
    : parseDocumentMetadata(
      await allowedDocumentTypes(serviceClient, cfg.record, entityId),
      payload.metadata && typeof payload.metadata === "object" ? payload.metadata as Record<string, unknown> : {},
    );
  if (!metadata.ok) return jsonResponse({ error: metadata.error }, request, 400);

  const denied = await cfg.checkAccess(entityId, "write");
  if (denied) return jsonResponse({ error: denied.error }, request, denied.status);

  // A new file can go straight into a folder of its record. A new version
  // stays where the file already is.
  let folderId: string | null = null;
  if (payload.folderId && !versionOf && (cfg.record === "client" || cfg.record === "engagement")) {
    const named = typeof payload.folderId === "string" ? payload.folderId : "";
    if (!isUuid(named)) return jsonResponse({ error: "Invalid folder." }, request, 400);
    let place;
    try {
      place = await placeFor(serviceClient, callerId, "folder", named);
    } catch (folderError) {
      return internalError(request, folderError, "read folder");
    }
    // A folder the caller doesn't see reads as not there.
    if (!place || !place.seen || place.recordId !== entityId) return jsonResponse({ error: "That folder is not on this record." }, request, 400);
    if (!place.canEdit) return jsonResponse({ error: "You can't add files to that folder." }, request, 403);
    folderId = named;
  }

  // A new version joins the family of the file it replaces, one above that
  // family's highest version (removed versions included, so a number is never
  // reused). It must be a file on this record.
  let family: { familyId: string; version: number } | null = null;
  if (versionOf) {
    const { doc: source, error: sourceError } = await readDocument(ctx, cfg, versionOf);
    if (sourceError) return internalError(request, sourceError, `read ${cfg.entityLabel} document`);
    if (!source || String(source[cfg.idColumn]) !== entityId) {
      return jsonResponse({ error: "The file this replaces is not on this record." }, request, 400);
    }
    const viewOnly = await fileEditRefusal(ctx, cfg, source);
    if (viewOnly) return jsonResponse({ error: viewOnly.error }, request, viewOnly.status);
    // A new version sits where its family does (the database holds to that too).
    folderId = typeof source.folder_id === "string" ? source.folder_id : null;
    const { data: top, error: topError } = await serviceClient
      .from(cfg.table)
      .select("version")
      .eq("family_id", source.family_id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (topError) return internalError(request, topError, `read ${cfg.entityLabel} document versions`);
    family = { familyId: source.family_id, version: Number(top?.version ?? source.version) + 1 };
  }

  // A new file needs a name nothing else here has; a new version keeps its family's place.
  if (!family && cfg.record !== "feature_request") {
    try {
      if (await fileNameTaken(serviceClient, cfg, entityId, folderId, fileName, null)) {
        // The upload has landed already; it isn't kept.
        await serviceClient.storage.from(cfg.bucket).remove([path]);
        return jsonResponse({ error: SAME_FILE_NAME }, request, 409);
      }
    } catch (nameError) {
      return internalError(request, nameError, `check ${cfg.entityLabel} document name`);
    }
  }

  // Confirm the object landed, and take the size from storage rather than the
  // caller where we can (the bucket limit already bounded the upload).
  const objectName = path.slice(entityId.length + 1);
  const { data: listed, error: listError } = await serviceClient
    .storage
    .from(cfg.bucket)
    .list(entityId, { search: objectName });
  if (listError) return internalError(request, listError, `stat ${cfg.entityLabel} document`);
  const object = (listed ?? []).find((o: { name?: string }) => o?.name === objectName);
  if (!object) {
    return jsonResponse({ error: "That file has not finished uploading. Try again." }, request, 400);
  }
  // What actually arrived is opened and checked before it is filed: it has to
  // be the kind its name says, with nothing in it that runs. The organisation
  // can switch each check off.
  const { data: stored, error: readError } = await serviceClient.storage.from(cfg.bucket).download(path);
  if (readError || !stored) return internalError(request, readError, `read ${cfg.entityLabel} document`);
  const refusal = await inspectFile(new Uint8Array(await stored.arrayBuffer()), fileName, rules.checksOff);
  if (refusal) {
    await serviceClient.storage.from(cfg.bucket).remove([path]);
    console.warn("upload refused on inspection", cfg.record, entityId, callerId, refusal);
    return jsonResponse({ error: refusal }, request, 400);
  }

  const storedSize = Number(
    (object as { metadata?: { size?: unknown; contentLength?: unknown } }).metadata?.size ??
      (object as { metadata?: { size?: unknown; contentLength?: unknown } }).metadata?.contentLength ??
      claimedSize,
  );

  const m = metadata.value;
  const { data: inserted, error: insertError } = await serviceClient
    .from(cfg.table)
    .insert({
      [cfg.idColumn]: entityId,
      file_name: fileName,
      content_type: contentType,
      size_bytes: storedSize,
      storage_path: path,
      uploaded_by: callerId,
      document_type: m.documentType,
      status: m.status,
      reference: m.reference,
      effective_from: m.effectiveFrom,
      effective_to: m.effectiveTo,
      note: m.note,
      ...(cfg.record === "feature_request" ? {} : { custom: m.custom }),
      ...(family ? { family_id: family.familyId, version: family.version } : {}),
      ...(folderId ? { folder_id: folderId } : {}),
    })
    .select("id, family_id")
    .single();

  if (insertError || !inserted?.id) {
    // Don't leave the object orphaned in the bucket if its row never landed.
    await serviceClient.storage.from(cfg.bucket).remove([path]);
    // Two new versions of one file at once: the (family, version) key refuses
    // the second rather than numbering both the same.
    if ((insertError as { code?: string } | null)?.code === "23505") {
      return jsonResponse({ error: "Someone else added a version of this file just now. Try again." }, request, 409);
    }
    return internalError(request, insertError, `${cfg.entityLabel} document insert`);
  }
  await logDocumentEvent(
    serviceClient,
    { record: cfg.record, id: inserted.id, family_id: inserted.family_id, file_name: fileName },
    family ? "version_added" : "uploaded",
    callerId,
    family ? `Version ${family.version}` : null,
  );

  return jsonResponse({ message: "Document attached.", id: inserted.id }, request);
}

/**
 * Who may change a file's details: anyone with write on its record, or the
 * Documents write grant (All, or Own on their own upload). Taking a file out
 * of Signed needs the Documents grant either way, since Signed is what stops
 * it being removed.
 */
export async function documentEditRefusal(
  ctx: DocumentHandlerContext,
  doc: DocumentRow,
  nextStatus: string,
  recordWriteAllowed: boolean,
): Promise<string | null> {
  const writeLevel = await callerLevel(ctx.serviceClient, ctx.callerId, "Documents", "write");
  const documentsGrant = writeLevel >= LEVEL_ALL || (writeLevel === LEVEL_OWN && doc.uploaded_by === ctx.callerId);
  if (!recordWriteAllowed && !documentsGrant) {
    return "You don't have permission to change this document's details.";
  }
  if (doc.status === "Signed" && nextStatus !== "Signed" && !documentsGrant) {
    return "Only someone who can manage documents can take a document out of Signed.";
  }
  return null;
}

/** Applies validated metadata to one file against its record. Used by the
 *  record functions and the Documents page. */
export async function updateDocumentMetadata(
  ctx: DocumentHandlerContext,
  cfg: Pick<DocumentEntityConfig, "table" | "idColumn" | "record" | "entityLabel">,
  request: Request,
  doc: DocumentRow,
  rawMetadata: unknown,
  recordWriteAllowed: boolean,
  /** The client or engagement the file is on. */
  entityId: string,
): Promise<Response> {
  const parsed = parseDocumentMetadata(
    // The type it already has stays allowed, even if its category is now off.
    await allowedDocumentTypes(ctx.serviceClient, cfg.record, entityId, String(doc.document_type ?? "")),
    rawMetadata && typeof rawMetadata === "object" ? rawMetadata as Record<string, unknown> : {},
  );
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, request, 400);
  if (doc.archived_at) return jsonResponse({ error: "Restore this document before changing it." }, request, 400);
  if (doc.approval_state === "pending") {
    return jsonResponse({ error: "This document is waiting for approval and can't change until it's decided." }, request, 400);
  }
  // Its type sets how long it's kept, so that is fixed once approved.
  if (doc.approval_state === "approved" && parsed.value.documentType !== doc.document_type) {
    return jsonResponse({ error: "An approved document's type can't change. Upload a new version instead." }, request, 400);
  }

  const refusal = await documentEditRefusal(ctx, doc, parsed.value.status, recordWriteAllowed);
  if (refusal) return jsonResponse({ error: refusal }, request, 403);

  const m = parsed.value;
  const { error } = await ctx.serviceClient
    .from(cfg.table)
    .update({
      document_type: m.documentType,
      status: m.status,
      reference: m.reference,
      effective_from: m.effectiveFrom,
      effective_to: m.effectiveTo,
      note: m.note,
      ...(cfg.record === "feature_request" ? {} : { custom: m.custom }),
      updated_at: new Date().toISOString(),
      updated_by: ctx.callerId,
    })
    .eq("id", doc.id);
  if (error) return internalError(request, error, `update ${cfg.entityLabel} document`);
  await logDocumentEvent(
    ctx.serviceClient,
    historyOf(cfg, doc),
    "details_changed",
    ctx.callerId,
    // The status is the change people look for; the rest is in the details.
    m.status !== doc.status ? `Status: ${doc.status} to ${m.status}` : null,
  );

  return jsonResponse({ message: "Document updated." }, request);
}

/** POST { documentId, metadata }: change a file's details from its record. */
export async function handleUpdateDocument(
  ctx: DocumentHandlerContext,
  cfg: DocumentEntityConfig,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const documentId = typeof payload.documentId === "string" ? payload.documentId.trim() : "";
  if (!isUuid(documentId)) return jsonResponse({ error: "Invalid documentId." }, request, 400);

  const { doc, error } = await readDocument(ctx, cfg, documentId);
  if (error) return internalError(request, error, `read ${cfg.entityLabel} document`);
  if (!doc) return jsonResponse({ error: "Document not found." }, request, 404);

  // Read on the record is the floor (an Own grant can't reach around it); write
  // on it is one of the two ways to be allowed to edit.
  const readDenied = await cfg.checkAccess(String(doc[cfg.idColumn]), "read");
  if (readDenied) return jsonResponse({ error: readDenied.error }, request, readDenied.status);
  const writeDenied = await cfg.checkAccess(String(doc[cfg.idColumn]), "write");
  const viewOnly = await fileEditRefusal(ctx, cfg, doc);
  if (viewOnly) return jsonResponse({ error: viewOnly.error }, request, viewOnly.status);

  return updateDocumentMetadata(ctx, cfg, request, doc, payload.metadata, writeDenied === null, String(doc[cfg.idColumn]));
}

/** POST { documentId }: Remove archives. The row and bytes stay, hidden and
 *  restorable. removalRefusal decides who may; a Signed file is never
 *  removed. */
export async function handleDeleteDocument(
  ctx: DocumentHandlerContext,
  cfg: DocumentEntityConfig,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const { serviceClient, callerId } = ctx;

  const documentId = typeof payload.documentId === "string" ? payload.documentId.trim() : "";
  if (!isUuid(documentId)) {
    return jsonResponse({ error: "Invalid documentId." }, request, 400);
  }

  const { doc, error } = await readDocument(ctx, cfg, documentId);
  if (error) return internalError(request, error, `read ${cfg.entityLabel} document`);
  if (!doc) return jsonResponse({ error: "Document not found." }, request, 404);
  if (doc.archived_at) return jsonResponse({ message: "Document removed." }, request);

  const deleteLevel = await documentsDeleteLevel(ctx);
  // The uploader's route needs write on the record, as uploading did; the
  // Documents grant only needs read (checkAccess still applies the record's Own
  // scope and archived guard).
  const denied = await cfg.checkAccess(String(doc[cfg.idColumn]), deleteLevel > 0 ? "read" : "write");
  if (denied) return jsonResponse({ error: denied.error }, request, denied.status);
  const viewOnly = await fileEditRefusal(ctx, cfg, doc);
  if (viewOnly) return jsonResponse({ error: viewOnly.error }, request, viewOnly.status);

  const refusal = heldOrRetained(doc, await orgToday(serviceClient)) ?? removalRefusal({
    status: doc.status,
    uploadedBy: doc.uploaded_by,
    callerId,
    createdAt: doc.created_at,
    now: new Date(),
    deleteLevel,
  });
  if (refusal) return jsonResponse({ error: refusal }, request, 403);

  const { error: archiveError } = await serviceClient
    .from(cfg.table)
    .update({ archived_at: new Date().toISOString(), archived_by: callerId })
    .eq("id", documentId);
  if (archiveError) return internalError(request, archiveError, `remove ${cfg.entityLabel} document`);
  await logDocumentEvent(serviceClient, historyOf(cfg, doc), "removed", callerId);

  return jsonResponse({ message: "Document removed." }, request);
}

/** POST { documentId }: restore a removed file. Needs Documents delete (All,
 *  or Own on their own upload). */
export async function handleRestoreDocument(
  ctx: DocumentHandlerContext,
  cfg: DocumentEntityConfig,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const documentId = typeof payload.documentId === "string" ? payload.documentId.trim() : "";
  if (!isUuid(documentId)) return jsonResponse({ error: "Invalid documentId." }, request, 400);

  const { doc, error } = await readDocument(ctx, cfg, documentId);
  if (error) return internalError(request, error, `read ${cfg.entityLabel} document`);
  if (!doc) return jsonResponse({ error: "Document not found." }, request, 404);
  if (!doc.archived_at) return jsonResponse({ message: "Document restored." }, request);

  const denied = await cfg.checkAccess(String(doc[cfg.idColumn]), "read");
  if (denied) return jsonResponse({ error: denied.error }, request, denied.status);
  if (!mayManageRemoved(await documentsDeleteLevel(ctx), doc.uploaded_by, ctx.callerId)) {
    return jsonResponse({ error: "Only someone who can manage documents can restore a removed file." }, request, 403);
  }
  const viewOnly = await fileEditRefusal(ctx, cfg, doc);
  if (viewOnly) return jsonResponse({ error: viewOnly.error }, request, viewOnly.status);
  // Coming back as its family's latest version, it takes its name back, so nothing else here may have it.
  if (cfg.record !== "feature_request") {
    const { data: later, error: laterError } = await ctx.serviceClient
      .from(cfg.table).select("id").eq("family_id", doc.family_id).is("archived_at", null).gt("version", doc.version).limit(1);
    if (laterError) return internalError(request, laterError, `read ${cfg.entityLabel} document versions`);
    try {
      const folderId = typeof doc.folder_id === "string" ? doc.folder_id : null;
      if ((later ?? []).length === 0 && await fileNameTaken(ctx.serviceClient, cfg, String(doc[cfg.idColumn]), folderId, doc.file_name, doc.family_id)) {
        return jsonResponse({ error: SAME_FILE_NAME }, request, 409);
      }
    } catch (nameError) {
      return internalError(request, nameError, `check ${cfg.entityLabel} document name`);
    }
  }

  const { error: restoreError } = await ctx.serviceClient
    .from(cfg.table)
    .update({ archived_at: null, archived_by: null })
    .eq("id", documentId);
  if (restoreError) return internalError(request, restoreError, `restore ${cfg.entityLabel} document`);
  await logDocumentEvent(ctx.serviceClient, historyOf(cfg, doc), "restored", ctx.callerId);

  return jsonResponse({ message: "Document restored." }, request);
}

/** POST { documentId }: erase a removed file for good. Row first, because a
 *  leftover object is invisible but a row pointing at nothing is a broken
 *  download. Documents delete only, and only from the removed list, so
 *  nothing live is one click from gone. */
export async function handlePurgeDocument(
  ctx: DocumentHandlerContext,
  cfg: DocumentEntityConfig,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const documentId = typeof payload.documentId === "string" ? payload.documentId.trim() : "";
  if (!isUuid(documentId)) return jsonResponse({ error: "Invalid documentId." }, request, 400);

  const { doc, error } = await readDocument(ctx, cfg, documentId);
  if (error) return internalError(request, error, `read ${cfg.entityLabel} document`);
  if (!doc) return jsonResponse({ error: "Document not found." }, request, 404);
  if (!doc.archived_at) {
    return jsonResponse({ error: "Remove the document first; only a removed document can be deleted for good." }, request, 400);
  }

  const denied = await cfg.checkAccess(String(doc[cfg.idColumn]), "read");
  if (denied) return jsonResponse({ error: denied.error }, request, denied.status);
  if (!mayManageRemoved(await documentsDeleteLevel(ctx), doc.uploaded_by, ctx.callerId)) {
    return jsonResponse({ error: "Only someone who can manage documents can delete a file for good." }, request, 403);
  }
  const viewOnly = await fileEditRefusal(ctx, cfg, doc);
  if (viewOnly) return jsonResponse({ error: viewOnly.error }, request, viewOnly.status);

  // A file removed before its hold or approval can still be held or retained.
  const held = heldOrRetained(doc, await orgToday(ctx.serviceClient));
  if (held) return jsonResponse({ error: held }, request, 403);

  const { error: deleteError } = await ctx.serviceClient.from(cfg.table).delete().eq("id", documentId);
  if (deleteError) return internalError(request, deleteError, `delete ${cfg.entityLabel} document`);
  await ctx.serviceClient.storage.from(cfg.bucket).remove([doc.storage_path]);
  await logDocumentEvent(ctx.serviceClient, historyOf(cfg, doc), "deleted", ctx.callerId);

  return jsonResponse({ message: "Document deleted." }, request);
}
