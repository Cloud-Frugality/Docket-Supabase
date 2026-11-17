import { withAuthorizedCaller } from "../_shared/serve.ts";
import type { ServiceClient } from "../_shared/service-client.ts";
import { internalError, jsonResponse } from "../_shared/http.ts";
import { callerLevel, callerTeams, LEVEL_ALL, LEVEL_OWN, requirePermission, type CallerTeams } from "../_shared/permissions.ts";
import { RATE_LIMIT_RESPONSE, takeRateLimitToken } from "../_shared/rate-limit.ts";
import { isUuid } from "../_shared/validation.ts";
import { selectAllRows } from "../_shared/paging.ts";
import { buildDisplayNameMap } from "../_shared/display-names.ts";
import { appToday } from "../_shared/app-date.ts";
import { loadOrgLocale } from "../_shared/organisation-locale.ts";
import { updateDocumentMetadata } from "../_shared/document-handlers.ts";
import { DOCUMENT_STATUSES, type DocumentRecord } from "../_shared/document-rules.ts";
import {
  APPROVAL_DECISIONS,
  APPROVAL_STATES,
  approvalRight,
  MAX_DECISION_COMMENT,
  nextApprovalFor,
  outstandingApprovers,
  retainUntil,
  submitRefusal,
  type ApprovalRight,
} from "../_shared/file-approval.ts";
import { loadRouting, type Routing } from "../_shared/approval-routing.ts";

/**
 * The Documents page and everything that happens to a stored file after it is
 * uploaded: finding it, changing its details, sending it for approval,
 * deciding it and putting it on hold. Read opens
 * the page (at Own, the files you uploaded, and any waiting on your decision).
 * Uploading, versions and removing stay on the file's record. Reads page
 * through the document_register view, filtered and counted at the query.
 */

// The two records the register covers. Feature request files are product
// feedback and stay out of it.
const REGISTER: Record<string, {
  table: string;
  idColumn: string;
  bucket: string;
  record: DocumentRecord;
  entityLabel: string;
}> = {
  engagement: {
    table: "engagement_documents",
    idColumn: "engagement_id",
    bucket: "engagement-documents",
    record: "engagement",
    entityLabel: "engagement",
  },
  client: {
    table: "client_documents",
    idColumn: "client_id",
    bucket: "client-documents",
    record: "client",
    entityLabel: "client",
  },
};

const ENTITY = "Documents";
const MAX_PAGE = 200;
const EXPIRING_DAYS = 60;
const DASHBOARD_ROWS = 8;

const REGISTER_COLUMNS =
  "id, record, record_id, record_name, client_id, client_name, work_type, team_id, record_archived_at, file_name, content_type, size_bytes, uploaded_by, created_at, document_type, status, reference, effective_from, effective_to, note, family_id, version, version_count, is_latest, updated_at, updated_by, archived_at, approval_state, submitted_by, submitted_at, decided_by, decided_for, decided_at, decision_comment, on_hold, retain_until";

type Row = Record<string, unknown>;

const list = (params: URLSearchParams, name: string) =>
  (params.get(name) ?? "").split(",").map((v) => v.trim()).filter(Boolean);

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const orgToday = async (serviceClient: ServiceClient) => appToday(new Date(), (await loadOrgLocale(serviceClient)).timeZone);

// deno-lint-ignore no-explicit-any
function applyFilters(query: any, params: URLSearchParams, ownUploader: string | null, today: string) {
  let q = query.eq("is_latest", true);
  if (ownUploader) q = q.eq("uploaded_by", ownUploader);

  const records = list(params, "records").filter((r) => r in REGISTER);
  if (records.length) q = q.in("record", records);
  const types = list(params, "types");
  if (types.length) q = q.in("document_type", types);
  const statuses = list(params, "statuses").filter((s) => (DOCUMENT_STATUSES as readonly string[]).includes(s));
  if (statuses.length) q = q.in("status", statuses);
  const approvalStates = list(params, "approvalStates").filter((s) => (APPROVAL_STATES as readonly string[]).includes(s));
  if (approvalStates.length) q = q.in("approval_state", approvalStates);
  // Kept: on hold, or still inside its retention period.
  if (params.get("kept") === "true") q = q.or(`on_hold.eq.true,retain_until.gt.${today}`);
  const clientIds = list(params, "clientIds").filter(isUuid);
  if (clientIds.length) q = q.in("client_id", clientIds);
  const workTypes = list(params, "workTypes");
  if (workTypes.length) q = q.in("work_type", workTypes);

  // Free text over the name, the reference and whose it is. PostgREST's or()
  // syntax gives commas, brackets and quotes meaning, so they're dropped.
  const search = (params.get("search") ?? "").replace(/[,()"'\\*%:]/g, " ").trim().slice(0, 100);
  if (search) {
    const like = `*${search}*`;
    q = q.or(
      `file_name.ilike.${like},reference.ilike.${like},record_name.ilike.${like},client_name.ilike.${like},note.ilike.${like}`,
    );
  }

  // In force: signed paper whose window covers today (only binding types
  // carry dates). Expiring is the
  // same but ending within 60 days; expired has ended.
  const effective = params.get("effective") ?? "";
  if (effective) {
    q = q.eq("status", "Signed");
    if (effective === "in_force") {
      q = q.or(`effective_from.is.null,effective_from.lte.${today}`).or(`effective_to.is.null,effective_to.gte.${today}`);
    } else if (effective === "expiring") {
      q = q.gte("effective_to", today).lte("effective_to", addDays(today, EXPIRING_DAYS));
    } else if (effective === "expired") {
      q = q.lt("effective_to", today);
    }
  }
  return q;
}

const PEOPLE_COLUMNS = ["uploaded_by", "updated_by", "submitted_by", "decided_by", "decided_for"] as const;

async function namesFor(serviceClient: ServiceClient, rows: Row[]) {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const column of PEOPLE_COLUMNS) {
      if (typeof row[column] === "string") ids.add(row[column] as string);
    }
  }
  return buildDisplayNameMap(serviceClient, ids);
}

function toDocument(row: Row, names: Map<string, string>) {
  const nameOf = (id: unknown) => (typeof id === "string" ? (names.get(id) ?? "Unknown") : null);
  return {
    id: row.id,
    record: row.record,
    recordId: row.record_id,
    recordName: row.record_name,
    recordArchived: !!row.record_archived_at,
    clientId: row.client_id,
    clientName: row.client_name,
    workType: row.work_type ?? null,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes ?? 0),
    uploadedByDisplayName: nameOf(row.uploaded_by) ?? "Unknown",
    createdAtUtc: row.created_at,
    documentType: row.document_type,
    status: row.status,
    reference: row.reference ?? null,
    effectiveFrom: row.effective_from ?? null,
    effectiveTo: row.effective_to ?? null,
    note: row.note ?? null,
    familyId: row.family_id,
    version: Number(row.version ?? 1),
    versionCount: Number(row.version_count ?? 1),
    archivedAtUtc: row.archived_at ?? null,
    updatedAtUtc: row.updated_at ?? null,
    updatedByDisplayName: nameOf(row.updated_by),
    approvalState: row.approval_state ?? "none",
    onHold: row.on_hold === true,
    retainUntil: row.retain_until ?? null,
  };
}

// ---------------------------------------------------------------- approval rights

/** Where one waiting file stands for the caller. */
interface Standing {
  right: ApprovalRight;
  routing: Routing;
  /** Whose approval the caller gives next where everyone must approve
   *  (their own, or someone they stand in for); null when none is left. */
  givesFor: string | null;
}

/** The file waits on something this caller can give now. */
const waitsOn = (standing: Standing | null | undefined) =>
  !!standing?.right.ok && (!standing.routing.requiresAll || standing.givesFor !== null);

/**
 * Where each waiting file stands for the caller, by file id. A file goes to
 * the group its category's rule names, else to its team's approvers; with
 * nobody to ask it falls to the global admins. Fails closed: a half-read pool
 * approves nothing.
 */
async function standings(
  serviceClient: ServiceClient,
  callerId: string,
  caller: CallerTeams,
  rows: readonly Row[],
): Promise<Map<string, Standing>> {
  const out = new Map<string, Standing>();
  if (rows.length === 0) return out;
  const [delegators, org] = await Promise.all([
    serviceClient.from("profiles").select("id").eq("delegate_id", callerId).eq("status", "active"),
    serviceClient.from("organisations").select("allow_self_approval").order("created_at").limit(1).maybeSingle(),
  ]);
  if (delegators.error ?? org.error) throw delegators.error ?? org.error;
  const delegatorIds = ((delegators.data ?? []) as Row[]).map((r) => String(r.id));
  // Where people may approve their own, nobody is treated as the uploader.
  const selfApproval = org.data?.allow_self_approval === true;
  const routings = await loadRouting(serviceClient, rows, selfApproval);
  for (const row of rows) {
    const routing = routings.get(String(row.id));
    if (!routing) continue;
    const uploaderId = selfApproval || typeof row.uploaded_by !== "string" ? null : row.uploaded_by;
    const right = approvalRight({ callerId, uploaderId, callerIsGlobalAdmin: caller.globalAdmin, pool: routing.pool, delegatorIds });
    out.set(String(row.id), {
      right,
      routing,
      givesFor: right.ok && routing.requiresAll
        ? nextApprovalFor({ callerId, pool: routing.pool, delegatorIds, approvedIds: routing.approvedIds })
        : null,
    });
  }
  return out;
}

/** One file as the register has it, or null. */
async function readRegisterRow(serviceClient: ServiceClient, record: string, documentId: string) {
  const { data, error } = await serviceClient
    .from("document_register")
    .select(REGISTER_COLUMNS)
    .eq("record", record)
    .eq("id", documentId)
    .maybeSingle();
  return { row: (data as Row | null) ?? null, error };
}

/** Where one file stands for the caller: only a waiting file has a standing. */
async function standingOn(serviceClient: ServiceClient, callerId: string, row: Row): Promise<Standing | null> {
  if (row.approval_state !== "pending") return null;
  const caller = await callerTeams(serviceClient, callerId);
  return (await standings(serviceClient, callerId, caller, [row])).get(String(row.id)) ?? null;
}

// ---------------------------------------------------------------- reads

async function handleList(serviceClient: ServiceClient, request: Request, params: URLSearchParams, ownUploader: string | null) {
  const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
  const limit = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(params.get("limit") ?? "24", 10) || 24));

  const { data, error, count } = await applyFilters(
    serviceClient.from("document_register").select(REGISTER_COLUMNS, { count: "exact" }),
    params,
    ownUploader,
    await orgToday(serviceClient),
  )
    .order("created_at", { ascending: false })
    .order("id")
    .range(offset, offset + limit - 1);
  if (error) return internalError(request, error, "document register");

  const rows = (data ?? []) as Row[];
  const names = await namesFor(serviceClient, rows);
  return jsonResponse({ documents: rows.map((row) => toDocument(row, names)), total: count ?? 0 }, request);
}

/** The filter drawer's options: only clients, types and kinds of work that
 *  have a file, so it never offers a choice that finds nothing. */
async function handleFacets(serviceClient: ServiceClient, request: Request, ownUploader: string | null) {
  const { data, error } = await selectAllRows(() => {
    let q = serviceClient
      .from("document_register")
      .select("id, record, client_id, client_name, document_type, work_type")
      .eq("is_latest", true);
    if (ownUploader) q = q.eq("uploaded_by", ownUploader);
    return q.order("id");
  });
  if (error) return internalError(request, error, "document facets");

  const clients = new Map<string, string>();
  const types = new Set<string>();
  const workTypes = new Set<string>();
  for (const row of data) {
    if (typeof row.client_id === "string") clients.set(row.client_id, String(row.client_name ?? ""));
    if (typeof row.document_type === "string") types.add(row.document_type);
    if (typeof row.work_type === "string" && row.work_type) workTypes.add(row.work_type);
  }
  return jsonResponse({
    clients: [...clients].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    types: [...types].sort(),
    workTypes: [...workTypes].sort(),
  }, request);
}

/** One file's family: every version, removed ones flagged, newest first. */
async function handleVersions(serviceClient: ServiceClient, request: Request, params: URLSearchParams, ownUploader: string | null) {
  const record = params.get("record") ?? "";
  const familyId = params.get("familyId") ?? "";
  if (!(record in REGISTER) || !isUuid(familyId)) return jsonResponse({ error: "Invalid document." }, request, 400);

  let q = serviceClient.from("document_register").select(REGISTER_COLUMNS).eq("record", record).eq("family_id", familyId);
  if (ownUploader) q = q.eq("uploaded_by", ownUploader);
  const { data, error } = await q.order("version", { ascending: false });
  if (error) return internalError(request, error, "document versions");
  const rows = (data ?? []) as Row[];
  const names = await namesFor(serviceClient, rows);
  return jsonResponse({ versions: rows.map((row) => toDocument(row, names)) }, request);
}

/** Home: what waits on the caller, what was added last, and how the files stand. */
async function handleDashboard(serviceClient: ServiceClient, request: Request, callerId: string, ownUploader: string | null) {
  const own = <Q extends { eq: (column: string, value: string) => Q }>(q: Q) => (ownUploader ? q.eq("uploaded_by", ownUploader) : q);
  const latest = () => serviceClient.from("document_register").select("id", { count: "exact", head: true }).eq("is_latest", true);
  const [waiting, recent, caller, ...counts] = await Promise.all([
    // Every waiting file, whoever uploaded it: an approver need not own it.
    selectAllRows(() => serviceClient.from("document_register").select(REGISTER_COLUMNS).eq("is_latest", true).eq("approval_state", "pending").order("id")),
    own(serviceClient.from("document_register").select(REGISTER_COLUMNS).eq("is_latest", true))
      .order("created_at", { ascending: false }).order("id").limit(DASHBOARD_ROWS),
    callerTeams(serviceClient, callerId),
    ...APPROVAL_STATES.map((state) => own(latest()).eq("approval_state", state)),
    own(latest()).eq("on_hold", true),
  ]);
  const failed = waiting.error ?? recent.error ?? counts.find((c) => c.error)?.error;
  if (failed) return internalError(request, failed, "document dashboard");

  const standing = await standings(serviceClient, callerId, caller, waiting.data);
  // Not the ones the caller has already approved and others still hold.
  const mine = waiting.data
    .filter((row) => waitsOn(standing.get(String(row.id))))
    .sort((a, b) => String(a.submitted_at ?? "").localeCompare(String(b.submitted_at ?? "")));
  const recentRows = (recent.data ?? []) as Row[];
  const names = await namesFor(serviceClient, [...mine, ...recentRows]);
  return jsonResponse({
    awaitingMe: mine.slice(0, 50).map((row) => toDocument(row, names)),
    awaitingMeCount: mine.length,
    recent: recentRows.map((row) => toDocument(row, names)),
    byState: Object.fromEntries(APPROVAL_STATES.map((state, i) => [state, counts[i].count ?? 0])),
    onHold: counts[APPROVAL_STATES.length].count ?? 0,
  }, request);
}

/** One file's approval, hold and retention, and what this caller may do about them. */
async function handleApproval(serviceClient: ServiceClient, request: Request, params: URLSearchParams, callerId: string, readLevel: number) {
  const record = params.get("record") ?? "";
  const documentId = params.get("documentId") ?? "";
  if (!(record in REGISTER) || !isUuid(documentId)) return jsonResponse({ error: "Invalid document." }, request, 400);
  const { row, error } = await readRegisterRow(serviceClient, record, documentId);
  if (error) return internalError(request, error, "read document");
  if (!row) return jsonResponse({ error: "Document not found." }, request, 404);

  const [standing, writeLevel, deleteLevel, today, flags, given] = await Promise.all([
    standingOn(serviceClient, callerId, row),
    callerLevel(serviceClient, callerId, ENTITY, "write"),
    callerLevel(serviceClient, callerId, ENTITY, "delete"),
    orgToday(serviceClient),
    serviceClient.from(REGISTER[record].table).select("decided_for_group").eq("id", documentId).maybeSingle(),
    serviceClient.from("document_approvals").select("profile_id").eq("record", record).eq("document_id", documentId),
  ]);
  if (flags.error ?? given.error) return internalError(request, flags.error ?? given.error, "read approvals");
  const right = standing?.right ?? null;
  const routing = standing?.routing ?? null;
  const mine = row.uploaded_by === callerId;
  if (readLevel < LEVEL_ALL && !mine && !right?.ok) return jsonResponse({ error: "Document not found." }, request, 404);

  const approvedIds = ((given.data ?? []) as Row[]).map((a) => String(a.profile_id));
  const names = await buildDisplayNameMap(serviceClient, new Set([
    ...PEOPLE_COLUMNS.map((c) => row[c]).filter((id): id is string => typeof id === "string"),
    ...(routing?.pool ?? []),
    ...approvedIds,
    ...(standing?.givesFor ? [standing.givesFor] : []),
  ]));
  const nameOf = (id: unknown) => (typeof id === "string" ? (names.get(id) ?? "Unknown") : null);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  // Whose approval the caller's Approve gives, when it isn't their own.
  const actingFor = !right?.ok ? null : routing?.requiresAll ? (standing?.givesFor === callerId ? null : standing?.givesFor ?? null) : right.actingFor;
  const outstanding = routing?.requiresAll ? outstandingApprovers(routing.pool, routing.approvedIds) : [];
  const refusal = submitRefusal({ approvalState: String(row.approval_state), archived: !!row.archived_at, isLatest: row.is_latest === true });
  const maySubmit = mine || writeLevel >= LEVEL_ALL;
  return jsonResponse({
    approval: {
      state: row.approval_state,
      submittedByDisplayName: nameOf(row.submitted_by),
      submittedAtUtc: row.submitted_at ?? null,
      decidedByDisplayName: nameOf(row.decided_by),
      decidedForDisplayName: nameOf(row.decided_for),
      decidedAtUtc: row.decided_at ?? null,
      decisionComment: row.decision_comment ?? null,
      // One member approved for a group that needed everyone.
      decidedForGroup: flags.data?.decided_for_group === true,
      canSubmit: maySubmit && refusal === null,
      canDecide: right?.ok === true,
      // Why the caller can't decide a waiting file, so the screen can say.
      decideReason: right && !right.ok ? right.reason : null,
      actingForDisplayName: nameOf(actingFor),
      // Who a waiting file is with: the group its rule names (null for the
      // default approvers) and the people who can approve it.
      approverGroupName: routing?.groupName ?? null,
      requiresAll: routing?.requiresAll === true,
      approvers: (routing?.pool ?? [])
        .map((id) => ({ name: names.get(id) ?? "Unknown", approved: routing?.requiresAll === true && routing.approvedIds.includes(id) }))
        .sort(byName),
      // The approvals a settled file gathered, where everyone was asked.
      approvedByNames: row.approval_state === "approved" ? approvedIds.map((id) => names.get(id) ?? "Unknown").sort() : [],
      // Approve gives one approval; for the group settles it without the rest.
      canApprove: waitsOn(standing),
      canApproveForGroup: right?.ok === true && outstanding.some((id) => id !== standing?.givesFor),
      onHold: row.on_hold === true,
      canHold: deleteLevel >= LEVEL_ALL && !row.archived_at,
      retainUntil: row.retain_until ?? null,
      retained: typeof row.retain_until === "string" && row.retain_until > today,
    },
  }, request);
}

async function handleUrl(serviceClient: ServiceClient, request: Request, params: URLSearchParams, callerId: string, readLevel: number) {
  const record = params.get("record") ?? "";
  const documentId = params.get("documentId") ?? "";
  if (!(record in REGISTER) || !isUuid(documentId)) return jsonResponse({ error: "Invalid document." }, request, 400);
  const cfg = REGISTER[record];
  const { row, error } = await readRegisterRow(serviceClient, record, documentId);
  if (error) return internalError(request, error, "read document");
  // At Own: your uploads, and a file waiting on your decision (you can't
  // approve what you can't read).
  const visible = !!row && (readLevel >= LEVEL_ALL || row.uploaded_by === callerId || (await standingOn(serviceClient, callerId, row))?.right.ok === true);
  if (!row || !visible) return jsonResponse({ error: "Document not found." }, request, 404);

  const { data: stored, error: storedError } = await serviceClient.from(cfg.table).select("storage_path").eq("id", documentId).maybeSingle();
  if (storedError || !stored) return internalError(request, storedError, "read document path");
  const { data: signed, error: signError } = await serviceClient
    .storage
    .from(cfg.bucket)
    .createSignedUrl(String(stored.storage_path), 60, { download: String(row.file_name) });
  if (signError || !signed?.signedUrl) return internalError(request, signError, "sign document");
  return jsonResponse({ url: signed.signedUrl, fileName: row.file_name }, request);
}

// ---------------------------------------------------------------- mutations

interface MutationContext {
  serviceClient: ServiceClient;
  callerId: string;
  request: Request;
  payload: Record<string, unknown>;
}

/** The file a mutation names, or the response that refuses it. */
async function namedFile(ctx: MutationContext): Promise<{ row: Row; table: string } | Response> {
  const record = typeof ctx.payload.record === "string" ? ctx.payload.record : "";
  const documentId = typeof ctx.payload.documentId === "string" ? ctx.payload.documentId : "";
  if (!(record in REGISTER) || !isUuid(documentId)) return jsonResponse({ error: "Invalid document." }, ctx.request, 400);
  const { row, error } = await readRegisterRow(ctx.serviceClient, record, documentId);
  if (error) return internalError(ctx.request, error, "read document");
  if (!row) return jsonResponse({ error: "Document not found." }, ctx.request, 404);
  return { row, table: REGISTER[record].table };
}

async function handleUpdate(ctx: MutationContext): Promise<Response> {
  const { serviceClient, callerId, request, payload } = ctx;
  const perm = await requirePermission(serviceClient, callerId, ENTITY, "write");
  if (!perm.ok) return jsonResponse({ error: perm.error }, request, perm.status);
  const file = await namedFile(ctx);
  if (file instanceof Response) return file;
  if (perm.level < LEVEL_ALL && file.row.uploaded_by !== callerId) {
    return jsonResponse({ error: "You can only change the details of files you uploaded." }, request, 403);
  }
  // Documents write is the gate here, not the record's write; the shared
  // helper rechecks that grant for the Signed rule.
  // deno-lint-ignore no-explicit-any
  return updateDocumentMetadata({ serviceClient, callerId }, REGISTER[String(file.row.record)], request, file.row as any, payload.metadata, false, String(file.row.record_id));
}

/** Send a file for approval: its uploader, or someone who manages documents. */
async function handleSubmit(ctx: MutationContext): Promise<Response> {
  const { serviceClient, callerId, request } = ctx;
  const file = await namedFile(ctx);
  if (file instanceof Response) return file;
  const { row, table } = file;
  if (row.uploaded_by !== callerId && (await callerLevel(serviceClient, callerId, ENTITY, "write")) < LEVEL_ALL) {
    return jsonResponse({ error: "Only the person who uploaded this file, or someone who can manage documents, can send it for approval." }, request, 403);
  }
  const refusal = submitRefusal({ approvalState: String(row.approval_state), archived: !!row.archived_at, isLatest: row.is_latest === true });
  if (refusal) return jsonResponse({ error: refusal }, request, 400);

  // A new round starts with nobody's approval.
  const cleared = await serviceClient.from("document_approvals").delete().eq("record", String(row.record)).eq("document_id", String(row.id));
  if (cleared.error) return internalError(request, cleared.error, "clear approvals");
  // The state is checked again in the update, so two submits can't both land.
  const { data, error } = await serviceClient
    .from(table)
    .update({
      approval_state: "pending",
      decided_for_group: false,
      submitted_by: callerId,
      submitted_at: new Date().toISOString(),
      decided_by: null,
      decided_for: null,
      decided_at: null,
      decision_comment: null,
    })
    .eq("id", row.id)
    .in("approval_state", ["none", "sent_back"])
    .select("id");
  if (error) return internalError(request, error, "submit document");
  if (!data?.length) return jsonResponse({ error: "This file's approval changed just now. Reload and try again." }, request, 409);
  return jsonResponse({ message: "Sent for approval." }, request);
}

/**
 * Approve a waiting file or send it back. Where its group needs everyone, an
 * approval is recorded and the file waits for the rest, unless the member
 * approves for the group (forGroup, with a reason). Approving starts its
 * retention.
 */
async function handleDecide(ctx: MutationContext): Promise<Response> {
  const { serviceClient, callerId, request, payload } = ctx;
  const decision = typeof payload.decision === "string" ? payload.decision : "";
  const comment = typeof payload.comment === "string" ? payload.comment.trim() : "";
  const forGroup = payload.forGroup === true;
  if (!(APPROVAL_DECISIONS as readonly string[]).includes(decision)) return jsonResponse({ error: "Invalid decision." }, request, 400);
  if (comment.length > MAX_DECISION_COMMENT) {
    return jsonResponse({ error: `The comment must be ${MAX_DECISION_COMMENT} characters or fewer.` }, request, 400);
  }
  if (decision === "sent_back" && !comment) return jsonResponse({ error: "Say what needs to change, so the uploader knows." }, request, 400);

  const file = await namedFile(ctx);
  if (file instanceof Response) return file;
  const { row, table } = file;
  if (row.approval_state !== "pending") return jsonResponse({ error: "This file is not waiting for approval." }, request, 400);
  const standing = await standingOn(serviceClient, callerId, row);
  if (!standing?.right.ok) {
    return jsonResponse({ error: standing && !standing.right.ok ? standing.right.reason : "You can't decide this file." }, request, 403);
  }
  const { right, routing, givesFor } = standing;
  const fileApprovals = { record: String(row.record), document_id: String(row.id) };

  let actingFor = right.actingFor;
  let settledForGroup = false;
  if (decision === "approved" && routing.requiresAll) {
    if (forGroup && !comment) return jsonResponse({ error: "Say why you are approving for the group." }, request, 400);
    if (!forGroup && givesFor === null) return jsonResponse({ error: "You have already approved this file." }, request, 400);
    if (givesFor !== null) {
      const { error } = await serviceClient.from("document_approvals").upsert(
        { ...fileApprovals, profile_id: givesFor, approved_by: callerId },
        { onConflict: "record,document_id,profile_id", ignoreDuplicates: true },
      );
      if (error) return internalError(request, error, "record approval");
    }
    // Read back, so two members approving together can't both think they're not last.
    const { data: given, error: givenError } = await serviceClient.from("document_approvals").select("profile_id").match(fileApprovals);
    if (givenError) return internalError(request, givenError, "read approvals");
    const waitingOn = outstandingApprovers(routing.pool, ((given ?? []) as Row[]).map((a) => String(a.profile_id)));
    if (waitingOn.length > 0 && !forGroup) return jsonResponse({ message: "Approval recorded.", waitingOn: waitingOn.length }, request);
    settledForGroup = waitingOn.length > 0;
    actingFor = givesFor !== null && givesFor !== callerId ? givesFor : null;
  }

  let keptUntil: string | null = null;
  if (decision === "approved") {
    const { data: kept, error: keptError } = await serviceClient
      .from("document_categories").select("retention_years").eq("name", String(row.document_type)).maybeSingle();
    if (keptError) return internalError(request, keptError, "read retention");
    keptUntil = retainUntil(await orgToday(serviceClient), kept?.retention_years ? Number(kept.retention_years) : null);
  }
  const { data, error } = await serviceClient
    .from(table)
    .update({
      approval_state: decision,
      decided_by: callerId,
      decided_for: actingFor,
      decided_for_group: settledForGroup,
      decided_at: new Date().toISOString(),
      decision_comment: comment || null,
      retain_until: keptUntil,
    })
    .eq("id", row.id)
    .eq("approval_state", "pending")
    .select("id");
  if (error) return internalError(request, error, "decide document");
  if (!data?.length) return jsonResponse({ error: "Someone else decided this file just now." }, request, 409);
  // Sent back: the approvals given so far don't carry to the next round.
  if (decision === "sent_back") await serviceClient.from("document_approvals").delete().match(fileApprovals);
  return jsonResponse({ message: decision === "approved" ? "Approved." : "Sent back." }, request);
}

/** Put a file on hold, or lift it. For whoever manages documents. */
async function handleSetHold(ctx: MutationContext): Promise<Response> {
  const { serviceClient, callerId, request, payload } = ctx;
  if (typeof payload.onHold !== "boolean") return jsonResponse({ error: "onHold must be true or false." }, request, 400);
  if ((await callerLevel(serviceClient, callerId, ENTITY, "delete")) < LEVEL_ALL) {
    return jsonResponse({ error: "Only someone who can manage documents can put a file on hold or lift it." }, request, 403);
  }
  const file = await namedFile(ctx);
  if (file instanceof Response) return file;
  const { error } = await serviceClient
    .from(file.table)
    .update({ on_hold: payload.onHold, hold_by: payload.onHold ? callerId : null, hold_at: payload.onHold ? new Date().toISOString() : null })
    .eq("id", file.row.id);
  if (error) return internalError(request, error, "hold document");
  return jsonResponse({ message: payload.onHold ? "On hold." : "Hold lifted." }, request);
}

// Each action and its handler. Every one checks its own grant, because they
// differ: details need Documents write, a decision needs the approval right.
const MUTATIONS: Record<string, (ctx: MutationContext) => Promise<Response>> = {
  update: handleUpdate,
  submit: handleSubmit,
  decide: handleDecide,
  set_hold: handleSetHold,
};

Deno.serve((request) =>
  withAuthorizedCaller(request, async ({ request, serviceClient, callerId }) => {
    // Reading is the floor for everything here, a decision included.
    const perm = await requirePermission(serviceClient, callerId, ENTITY, "read");
    if (!perm.ok) return jsonResponse({ error: perm.error }, request, perm.status);

    if (request.method === "GET") {
      const params = new URL(request.url).searchParams;
      // Own: the files you uploaded.
      const ownUploader = perm.level === LEVEL_OWN ? callerId : null;
      const action = params.get("action") ?? "list";
      if (action === "list") return handleList(serviceClient, request, params, ownUploader);
      if (action === "facets") return handleFacets(serviceClient, request, ownUploader);
      if (action === "versions") return handleVersions(serviceClient, request, params, ownUploader);
      if (action === "dashboard") return handleDashboard(serviceClient, request, callerId, ownUploader);
      if (action === "approval") return handleApproval(serviceClient, request, params, callerId, perm.level);
      if (action === "document_url") return handleUrl(serviceClient, request, params, callerId, perm.level);
      return jsonResponse({ error: `Unknown action: ${action}` }, request, 400);
    }

    // Changes come one at a time; this stops a script, not a person.
    const allowed = await takeRateLimitToken(serviceClient, `documents:${callerId}`, 20, 0.5);
    if (!allowed) return jsonResponse({ error: RATE_LIMIT_RESPONSE.error }, request, RATE_LIMIT_RESPONSE.status);

    let payload: Record<string, unknown> = {};
    try {
      payload = await request.json();
    } catch {
      payload = {};
    }
    const action = typeof payload.action === "string" ? payload.action : "";
    const handler = MUTATIONS[action];
    if (!handler) return jsonResponse({ error: `Unknown action: ${action}` }, request, 400);
    return handler({ serviceClient, callerId, request, payload });
  }));
