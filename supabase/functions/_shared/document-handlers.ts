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
import { buildDisplayNameMap } from "./display-names.ts";
import { callerLevel, LEVEL_ALL, LEVEL_OWN } from "./permissions.ts";
import { legacyMetadata, parseDocumentMetadata, removalRefusal, type DocumentRecord } from "./document-rules.ts";
import { retentionRefusal } from "./file-approval.ts";
import { allowedDocumentTypes } from "./document-categories.ts";
import { appToday } from "./app-date.ts";
import { loadOrgLocale } from "./organisation-locale.ts";
import type { ServiceClient } from "./service-client.ts";

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
const APPROVAL_COLUMNS = ", approval_state, on_hold, retain_until";
const columnsFor = (cfg: Pick<DocumentEntityConfig, "record">) =>
  cfg.record === "feature_request" ? DOCUMENT_COLUMNS : DOCUMENT_COLUMNS + APPROVAL_COLUMNS;

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
  return { doc: (data as DocumentRow | null) ?? null, error };
}

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

  const { data, error } = await ctx.serviceClient
    .from(cfg.table)
    .select(columnsFor(cfg))
    .eq(cfg.idColumn, entityId)
    .order("created_at", { ascending: false });

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
  return jsonResponse({ url: signed.signedUrl, fileName: doc.file_name }, request);
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

  const invalid = validateDocument({ fileName, contentType, sizeBytes });
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

  const invalid = validateDocument({ fileName, contentType, sizeBytes: claimedSize });
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
      ...(family ? { family_id: family.familyId, version: family.version } : {}),
    })
    .select("id")
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
      updated_at: new Date().toISOString(),
      updated_by: ctx.callerId,
    })
    .eq("id", doc.id);
  if (error) return internalError(request, error, `update ${cfg.entityLabel} document`);


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

  const { error: restoreError } = await ctx.serviceClient
    .from(cfg.table)
    .update({ archived_at: null, archived_by: null })
    .eq("id", documentId);
  if (restoreError) return internalError(request, restoreError, `restore ${cfg.entityLabel} document`);


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

  // A file removed before its hold or approval can still be held or retained.
  const held = heldOrRetained(doc, await orgToday(ctx.serviceClient));
  if (held) return jsonResponse({ error: held }, request, 403);

  const { error: deleteError } = await ctx.serviceClient.from(cfg.table).delete().eq("id", documentId);
  if (deleteError) return internalError(request, deleteError, `delete ${cfg.entityLabel} document`);
  await ctx.serviceClient.storage.from(cfg.bucket).remove([doc.storage_path]);


  return jsonResponse({ message: "Document deleted." }, request);
}
