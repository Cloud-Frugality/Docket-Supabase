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
import { fileNameTaken, updateDocumentMetadata } from "../_shared/document-handlers.ts";
import { binScope, DOCUMENT_STATUSES, peopleOptions, SAME_FILE_NAME, type DocumentRecord } from "../_shared/document-rules.ts";
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
import { folderDeleteRefusal, parseFolderName } from "../_shared/document-folders.ts";
import { disposalRefusal, extensionRefusal, MAX_DISPOSAL_REASON } from "../_shared/document-disposal.ts";
import {
  accessSummary,
  LOCKED_SHARE,
  mayManageAccess,
  mayRemoveShare,
  parseAccessPeople,
  parseAccessTarget,
  parseShareExpiry,
  placeRefusal,
  reachParts,
  rowInReach,
  VIEW_ONLY,
  type AccessTarget,
  type Reach,
} from "../_shared/document-access.ts";
import {
  applyOwnScope,
  applyShared,
  clientsFor,
  engagementsFor,
  fileCanEdit,
  foldersFor,
  loadReach,
  placeFor,
  placesFor,
  registerFor,
  teamParam,
  type Place,
} from "../_shared/document-access-load.ts";
import { logDocumentEvent } from "../_shared/document-events-log.ts";
import { addTemplateFolders } from "../_shared/folder-template-apply.ts";
import { allowedDocumentTypes } from "../_shared/document-categories.ts";
import { leaveRefusal, mayFileOnClient, mayFileOnEngagement, moveTargets, moveTeamRefusal, type Mover } from "../_shared/document-move.ts";

/**
 * The Documents page and everything that happens to a stored file after it is
 * uploaded: finding it, changing its details, sending it for approval,
 * deciding it and putting it on hold, and who an item is locked to or shared
 * with. Read opens the page (at Own, the files you uploaded or reach, and any
 * waiting on your decision). Uploading, versions and removing stay on the
 * file's record. Reads page through register_for, the files the caller sees,
 * filtered and counted at the query.
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
  "id, record, record_id, record_name, client_id, client_name, work_type, team_id, record_archived_at, file_name, content_type, size_bytes, uploaded_by, created_at, document_type, status, reference, effective_from, effective_to, note, family_id, version, version_count, is_latest, updated_at, updated_by, archived_at, archived_by, approval_state, submitted_by, submitted_at, decided_by, decided_for, decided_at, decision_comment, on_hold, retain_until, folder_id, custom, restricted";

type Row = Record<string, unknown>;

const list = (params: URLSearchParams, name: string) =>
  (params.get(name) ?? "").split(",").map((v) => v.trim()).filter(Boolean);

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const orgToday = async (serviceClient: ServiceClient) => appToday(new Date(), (await loadOrgLocale(serviceClient)).timeZone);

/** Who is reading, worked out once per request. */
interface Reader {
  serviceClient: ServiceClient;
  callerId: string;
  /** Set at Documents Own: then only what they uploaded or reach. */
  ownUploader: string | null;
  reach: Reach;
  /** The one team a list is narrowed to, or null for every team. */
  teamId: string | null;
}

// deno-lint-ignore no-explicit-any
const inTeam = (query: any, teamId: string | null) => (teamId ? query.eq("team_id", teamId) : query);

// deno-lint-ignore no-explicit-any
function applyFilters(query: any, params: URLSearchParams, reader: Reader, today: string, removed = false) {
  // The recycle bin lists what was removed; everything else the live, latest versions.
  let q = removed ? query.not("archived_at", "is", null) : query.eq("is_latest", true);
  // The bin is only ever your own removals; a share doesn't reach into it.
  if (removed) q = reader.ownUploader ? q.eq("uploaded_by", reader.ownUploader) : q;
  else q = applyOwnScope(q, reader.ownUploader, reader.reach);
  // Shared with Me: what the caller is added to or shared, across every team.
  if (params.get("shared") === "true") q = applyShared(q, reader.reach) ?? q;
  else q = inTeam(q, reader.teamId);

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
  // Due: its retention has run out and nothing holds it, so it waits for review.
  if (params.get("due") === "true") q = q.not("retain_until", "is", null).lte("retain_until", today).eq("on_hold", false);
  const clientIds = list(params, "clientIds").filter(isUuid);
  if (clientIds.length) q = q.in("client_id", clientIds);
  // The one client or engagement a folder of the Documents page stands for.
  const recordIds = list(params, "recordIds").filter(isUuid);
  if (recordIds.length) q = q.in("record_id", recordIds);
  const folderId = params.get("folderId") ?? "";
  if (isUuid(folderId)) q = q.eq("folder_id", folderId);
  // Only what sits directly on its record, in no folder.
  else if (params.get("direct") === "true") q = q.is("folder_id", null);
  const workTypes = list(params, "workTypes");
  if (workTypes.length) q = q.in("work_type", workTypes);
  const uploaderIds = list(params, "uploaderIds").filter(isUuid);
  if (uploaderIds.length) q = q.in("uploaded_by", uploaderIds);
  const removedByIds = list(params, "removedByIds").filter(isUuid);
  if (removedByIds.length) q = q.in("archived_by", removedByIds);

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

const PEOPLE_COLUMNS = ["uploaded_by", "updated_by", "archived_by", "submitted_by", "decided_by", "decided_for"] as const;

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
    archivedByDisplayName: nameOf(row.archived_by),
    updatedAtUtc: row.updated_at ?? null,
    updatedByDisplayName: nameOf(row.updated_by),
    approvalState: row.approval_state ?? "none",
    onHold: row.on_hold === true,
    retainUntil: row.retain_until ?? null,
    folderId: row.folder_id ?? null,
    custom: row.custom && typeof row.custom === "object" ? row.custom : {},
    restricted: row.restricted === true,
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

/** One file as the register has it, or null when there is none the caller sees. */
async function readRegisterRow(serviceClient: ServiceClient, callerId: string, record: string, documentId: string) {
  const { data, error } = await registerFor(serviceClient, callerId, REGISTER_COLUMNS)
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

async function handleList(reader: Reader, request: Request, params: URLSearchParams, removed = false) {
  const { serviceClient } = reader;
  const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
  const limit = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(params.get("limit") ?? "24", 10) || 24));
  // Nothing is shared with the caller, so there is nothing to ask for.
  if (params.get("shared") === "true" && reachParts(reader.reach).length === 0) {
    return jsonResponse({ documents: [], total: 0 }, request);
  }

  const { data, error, count } = await applyFilters(
    registerFor(serviceClient, reader.callerId, REGISTER_COLUMNS, { count: "exact" }),
    params,
    reader,
    await orgToday(serviceClient),
    removed,
  )
    // The bin reads newest removed first.
    .order(removed ? "archived_at" : "created_at", { ascending: false })
    .order("id")
    .range(offset, offset + limit - 1);
  if (error) return internalError(request, error, "document register");

  const rows = (data ?? []) as Row[];
  const names = await namesFor(serviceClient, rows);
  return jsonResponse({ documents: rows.map((row) => toDocument(row, names)), total: count ?? 0 }, request);
}

/** The filter drawer's options: only clients, types and kinds of work that
 *  have a file, so it never offers a choice that finds nothing. */
async function handleFacets(reader: Reader, request: Request) {
  const { serviceClient } = reader;
  const { data, error } = await selectAllRows(() => {
    const q = registerFor(serviceClient, reader.callerId, "id, record, record_id, client_id, client_name, document_type, work_type, uploaded_by")
      .eq("is_latest", true);
    return inTeam(applyOwnScope(q, reader.ownUploader, reader.reach), reader.teamId).order("id");
  });
  if (error) return internalError(request, error, "document facets");

  const clients = new Map<string, string>();
  const types = new Set<string>();
  const workTypes = new Set<string>();
  const uploaderIds = new Set<string>();
  // How many files each client has in all, and each client's own files or engagement.
  const clientFiles: Record<string, number> = {};
  const recordFiles: Record<string, number> = {};
  for (const row of data) {
    if (typeof row.uploaded_by === "string") uploaderIds.add(row.uploaded_by);
    if (typeof row.client_id === "string") {
      clients.set(row.client_id, String(row.client_name ?? ""));
      clientFiles[row.client_id] = (clientFiles[row.client_id] ?? 0) + 1;
    }
    const recordKey = `${row.record}:${row.record_id}`;
    recordFiles[recordKey] = (recordFiles[recordKey] ?? 0) + 1;
    if (typeof row.document_type === "string") types.add(row.document_type);
    if (typeof row.work_type === "string" && row.work_type) workTypes.add(row.work_type);
  }
  const names = await buildDisplayNameMap(serviceClient, uploaderIds);
  return jsonResponse({
    clients: [...clients].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    types: [...types].sort(),
    workTypes: [...workTypes].sort(),
    uploaders: peopleOptions(uploaderIds, names),
    counts: { clients: clientFiles, records: recordFiles },
  }, request);
}

/**
 * Where the recycle bin's files were filed: only the clients, engagements and
 * folders that have a removed file, and how many each holds. `uploader`
 * narrows it to one person's removals, as the bin's list is.
 */
async function handleBinTree(reader: Reader, request: Request, uploader: string | null) {
  const { serviceClient } = reader;
  const { data, error } = await selectAllRows(() => {
    const q = registerFor(serviceClient, reader.callerId, "id, record, record_id, record_name, client_id, client_name, folder_id, document_type, archived_by")
      .not("archived_at", "is", null);
    return inTeam(uploader ? q.eq("uploaded_by", uploader) : q, reader.teamId).order("id");
  });
  if (error) return internalError(request, error, "recycle bin tree");

  const clients = new Map<string, { id: string; name: string; canFile: boolean; engagements: Map<string, string> }>();
  const counts = { clients: {} as Record<string, number>, records: {} as Record<string, number>, folders: {} as Record<string, number> };
  const add = (into: Record<string, number>, key: string) => { into[key] = (into[key] ?? 0) + 1; };
  // What the list's column filters offer: only what a removed file has.
  const types = new Set<string>();
  const removerIds = new Set<string>();
  for (const row of data as Row[]) {
    if (typeof row.document_type === "string") types.add(row.document_type);
    if (typeof row.archived_by === "string") removerIds.add(row.archived_by);
    const clientId = String(row.client_id);
    const client = clients.get(clientId) ?? { id: clientId, name: String(row.client_name ?? ""), canFile: false, engagements: new Map() };
    clients.set(clientId, client);
    // `canFile` is the tree's word for "show the client's own files".
    if (row.record === "client") client.canFile = true;
    else client.engagements.set(String(row.record_id), String(row.record_name ?? ""));
    add(counts.clients, clientId);
    add(counts.records, `${row.record}:${row.record_id}`);
    if (typeof row.folder_id === "string") add(counts.folders, row.folder_id);
  }
  const names = await buildDisplayNameMap(serviceClient, removerIds);
  return jsonResponse({
    types: [...types].sort(),
    removers: peopleOptions(removerIds, names),
    clients: [...clients.values()].map((c) => ({
      id: c.id,
      name: c.name,
      canFile: c.canFile,
      engagements: [...c.engagements].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    })),
    counts,
  }, request);
}

// A folder is on a client or an engagement, named by one of two columns.
const folderOwner = (record: string) => (record === "client" ? "client_id" : "engagement_id");

/** Every folder the caller sees on one client or engagement. The page nests them by parent. */
async function handleFolders(reader: Reader, request: Request, params: URLSearchParams) {
  const { serviceClient } = reader;
  const record = params.get("record") ?? "";
  const recordId = params.get("recordId") ?? "";
  if (!(record in REGISTER) || !isUuid(recordId)) return jsonResponse({ error: "Invalid record." }, request, 400);
  const [{ data, error }, files] = await Promise.all([
    foldersFor(serviceClient, reader.callerId, "id, parent_id, name, restricted")
      .eq(folderOwner(record), recordId)
      .order("name"),
    // The files the caller's list would show here, so a count never gives away one it hides.
    selectAllRows(() => {
      const q = registerFor(serviceClient, reader.callerId, "id, folder_id")
        .not("folder_id", "is", null)
        .eq("record", record)
        .eq("record_id", recordId)
        .eq("is_latest", true);
      return applyOwnScope(q, reader.ownUploader, reader.reach).order("id");
    }),
  ]);
  if (error ?? files.error) return internalError(request, error ?? files.error, "document folders");
  const inFolder = new Map<string, number>();
  for (const file of files.data as Row[]) {
    if (typeof file.folder_id === "string") inFolder.set(file.folder_id, (inFolder.get(file.folder_id) ?? 0) + 1);
  }
  return jsonResponse({
    folders: ((data ?? []) as Row[])
      .map((f) => ({
        id: f.id,
        parentId: f.parent_id ?? null,
        name: f.name,
        restricted: f.restricted === true,
        files: inFolder.get(String(f.id)) ?? 0,
      })),
  }, request);
}

/** Every folder the caller sees, on every record (or one team's), for the tree's search. */
async function handleAllFolders(reader: Reader, request: Request) {
  const { serviceClient, callerId, teamId } = reader;
  const [{ data, error }, ofTeam] = await Promise.all([
    selectAllRows(() => foldersFor(serviceClient, callerId, "id, parent_id, name, restricted, client_id, engagement_id").order("id")),
    // A folder's team is its record's, which places_for has.
    teamId
      ? selectAllRows(() => placesFor(serviceClient, callerId).eq("kind", "folder").eq("seen", true).eq("team_id", teamId).order("id"))
      : Promise.resolve({ data: [] as Row[], error: null }),
  ]);
  if (error ?? ofTeam.error) return internalError(request, error ?? ofTeam.error, "document folders");
  const teamFolders = new Set(ofTeam.data.map((p) => String(p.id)));
  return jsonResponse({
    folders: (data as Row[])
      .filter((f) => !teamId || teamFolders.has(String(f.id)))
      .map((f) => ({
        id: f.id,
        parentId: f.parent_id ?? null,
        name: f.name,
        restricted: f.restricted === true,
        record: f.client_id ? "client" : "engagement",
        recordId: f.client_id ?? f.engagement_id,
      })),
  }, request);
}

/** Who is asking, for the rules on adding a file to a client or an engagement. */
async function moverOf(serviceClient: ServiceClient, callerId: string, caller: CallerTeams): Promise<Mover> {
  const [clientLevel, engagementLevel] = await Promise.all([
    callerLevel(serviceClient, callerId, "Clients", "write"),
    callerLevel(serviceClient, callerId, "Engagements", "write"),
  ]);
  return { callerId, clientLevel, engagementLevel, teamIds: caller.teamIds };
}

/** Every client and engagement the caller may move a file to: ones they can edit, in one team when asked. */
async function handleMoveTargets(reader: Reader, request: Request, caller: CallerTeams) {
  const { serviceClient, callerId, teamId } = reader;
  const [who, places, clients, engagements] = await Promise.all([
    moverOf(serviceClient, callerId, caller),
    selectAllRows(() => placesFor(serviceClient, callerId).in("kind", ["client", "engagement"]).eq("can_edit", true).order("id")),
    selectAllRows(() => inTeam(clientsFor(serviceClient, callerId, "id, name, created_by, team_id").is("archived_at", null), teamId).order("id")),
    selectAllRows(() => inTeam(engagementsFor(serviceClient, callerId, "id, name, client_id, team_id").is("archived_at", null), teamId).order("id")),
  ]);
  const failed = places.error ?? clients.error ?? engagements.error;
  if (failed) return internalError(request, failed, "move targets");
  const editable = new Set(places.data.map((p) => String(p.id)));
  return jsonResponse({
    targets: moveTargets(
      clients.data.map((c) => ({
        id: String(c.id),
        name: String(c.name),
        createdBy: typeof c.created_by === "string" ? c.created_by : null,
        teamId: String(c.team_id),
        canEdit: editable.has(String(c.id)),
      })),
      engagements.data.map((e) => ({
        id: String(e.id),
        name: String(e.name),
        clientId: String(e.client_id),
        teamId: String(e.team_id),
        canEdit: editable.has(String(e.id)),
      })),
      who,
    ),
  }, request);
}

/** One file's family: every version, removed ones flagged, newest first. */
async function handleVersions(reader: Reader, request: Request, params: URLSearchParams) {
  const { serviceClient } = reader;
  const record = params.get("record") ?? "";
  const familyId = params.get("familyId") ?? "";
  if (!(record in REGISTER) || !isUuid(familyId)) return jsonResponse({ error: "Invalid document." }, request, 400);

  const q = registerFor(serviceClient, reader.callerId, REGISTER_COLUMNS).eq("record", record).eq("family_id", familyId);
  const { data, error } = await applyOwnScope(q, reader.ownUploader, reader.reach).order("version", { ascending: false });
  if (error) return internalError(request, error, "document versions");
  const rows = (data ?? []) as Row[];
  const names = await namesFor(serviceClient, rows);
  return jsonResponse({ versions: rows.map((row) => toDocument(row, names)) }, request);
}

/** Home: what waits on the caller, what was added last, and how the files stand. */
async function handleDashboard(reader: Reader, request: Request) {
  const { serviceClient, callerId } = reader;
  // deno-lint-ignore no-explicit-any
  const own = (q: any) => inTeam(applyOwnScope(q, reader.ownUploader, reader.reach), reader.teamId);
  const latest = () => registerFor(serviceClient, callerId, "id", { count: "exact", head: true }).eq("is_latest", true);
  const [waiting, recent, caller, ...counts] = await Promise.all([
    // Every waiting file the caller sees, whoever uploaded it: an approver need not own it.
    selectAllRows(() =>
      inTeam(registerFor(serviceClient, callerId, REGISTER_COLUMNS).eq("is_latest", true).eq("approval_state", "pending"), reader.teamId).order("id")
    ),
    own(registerFor(serviceClient, callerId, REGISTER_COLUMNS).eq("is_latest", true))
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
async function handleApproval(reader: Reader, request: Request, params: URLSearchParams, readLevel: number) {
  const { serviceClient, callerId } = reader;
  const record = params.get("record") ?? "";
  const documentId = params.get("documentId") ?? "";
  if (!(record in REGISTER) || !isUuid(documentId)) return jsonResponse({ error: "Invalid document." }, request, 400);
  const { row, error } = await readRegisterRow(serviceClient, callerId, record, documentId);
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
  if (readLevel < LEVEL_ALL && !mine && !right?.ok && !rowInReach(row, reader.reach)) return jsonResponse({ error: "Document not found." }, request, 404);

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

async function handleUrl(reader: Reader, request: Request, params: URLSearchParams, readLevel: number) {
  const { serviceClient, callerId } = reader;
  const record = params.get("record") ?? "";
  const documentId = params.get("documentId") ?? "";
  if (!(record in REGISTER) || !isUuid(documentId)) return jsonResponse({ error: "Invalid document." }, request, 400);
  const cfg = REGISTER[record];
  const { row, error } = await readRegisterRow(serviceClient, callerId, record, documentId);
  if (error) return internalError(request, error, "read document");
  // At Own: your uploads, what you are added to or shared, and a file waiting
  // on your decision (you can't approve what you can't read).
  const visible = !!row &&
    (readLevel >= LEVEL_ALL || row.uploaded_by === callerId || rowInReach(row, reader.reach) ||
      (await standingOn(serviceClient, callerId, row))?.right.ok === true);
  if (!row || !visible) return jsonResponse({ error: "Document not found." }, request, 404);

  const { data: stored, error: storedError } = await serviceClient.from(cfg.table).select("storage_path").eq("id", documentId).maybeSingle();
  if (storedError || !stored) return internalError(request, storedError, "read document path");
  const { data: signed, error: signError } = await serviceClient
    .storage
    .from(cfg.bucket)
    .createSignedUrl(String(stored.storage_path), 60, { download: String(row.file_name) });
  if (signError || !signed?.signedUrl) return internalError(request, signError, "sign document");
  await logDocumentEvent(serviceClient, row, "opened", callerId);
  return jsonResponse({ url: signed.signedUrl, fileName: row.file_name }, request);
}

/** One file's history, every version of it, newest first. */
async function handleHistory(reader: Reader, request: Request, params: URLSearchParams) {
  const { serviceClient } = reader;
  const record = params.get("record") ?? "";
  const familyId = params.get("familyId") ?? "";
  if (!(record in REGISTER) || !isUuid(familyId)) return jsonResponse({ error: "Invalid document." }, request, 400);
  // Only for a file the caller can see.
  const seen = registerFor(serviceClient, reader.callerId, "id").eq("record", record).eq("family_id", familyId);
  const { data: file, error: fileError } = await applyOwnScope(seen, reader.ownUploader, reader.reach).limit(1);
  if (fileError) return internalError(request, fileError, "read document");
  if (!file?.length) return jsonResponse({ error: "Document not found." }, request, 404);

  const { data, error } = await serviceClient
    .from("document_events")
    .select("id, action, actor, detail, created_at")
    .eq("record", record)
    .eq("family_id", familyId)
    .order("created_at", { ascending: false })
    .limit(MAX_PAGE);
  if (error) return internalError(request, error, "document history");
  const rows = (data ?? []) as Row[];
  const names = await buildDisplayNameMap(serviceClient, new Set(rows.map((r) => r.actor).filter((id): id is string => typeof id === "string")));
  return jsonResponse({
    events: rows.map((r) => ({
      id: r.id,
      action: r.action,
      // Null is the nightly clean-up, which nobody did.
      actorDisplayName: typeof r.actor === "string" ? (names.get(r.actor) ?? "Unknown") : null,
      detail: r.detail ?? null,
      atUtc: r.created_at,
    })),
  }, request);
}

/** The disposal record: every file destroyed at the end of its retention, newest first. */
async function handleDisposals(serviceClient: ServiceClient, request: Request, params: URLSearchParams, callerId: string) {
  if ((await callerLevel(serviceClient, callerId, ENTITY, "delete")) < LEVEL_ALL) {
    return jsonResponse({ error: "Only someone who can manage documents can read the disposal record." }, request, 403);
  }
  const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
  const limit = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(params.get("limit") ?? "24", 10) || 24));
  let q = serviceClient
    .from("document_disposals")
    .select("id, record, file_name, document_type, client_name, record_name, versions, retained_until, reason, disposed_by_name, disposed_at", { count: "exact" });
  const search = (params.get("search") ?? "").replace(/[,()"'\\*%:]/g, " ").trim().slice(0, 100);
  if (search) q = q.or(`file_name.ilike.*${search}*,client_name.ilike.*${search}*,record_name.ilike.*${search}*`);
  const { data, error, count } = await q.order("disposed_at", { ascending: false }).order("id").range(offset, offset + limit - 1);
  if (error) return internalError(request, error, "disposal record");
  return jsonResponse({
    disposals: ((data ?? []) as Row[]).map((d) => ({
      id: d.id,
      record: d.record,
      fileName: d.file_name,
      documentType: d.document_type,
      clientName: d.client_name,
      recordName: d.record_name,
      versions: Number(d.versions ?? 1),
      retainedUntil: d.retained_until,
      reason: d.reason,
      disposedByDisplayName: d.disposed_by_name,
      disposedAtUtc: d.disposed_at,
    })),
    total: count ?? 0,
  }, request);
}

// The column that names each kind of item in document_access and document_shares.
const ITEM_COLUMN: Record<string, string> = { client: "client_id", engagement: "engagement_id", folder: "folder_id", file: "family_id" };
const ITEM_TABLE: Record<string, string> = { client: "clients", engagement: "engagements", folder: "document_folders" };

/** An item the access and share actions name, as the caller stands to it. */
interface AccessItem {
  target: AccessTarget;
  teamId: string;
  restricted: boolean;
  /** Locked here or above, so it can't be shared. */
  locked: boolean;
  /** A file whose first version the caller uploaded. */
  uploadedByCaller: boolean;
  /** Can edit on it, by the visibility rule (team admins and global admins always). */
  canEdit: boolean;
  /** For a file, its latest version, which its history is written against. */
  file: Row | null;
}

/** The item, if the caller sees it, or the response that refuses it. */
async function accessItem(serviceClient: ServiceClient, callerId: string, request: Request, target: AccessTarget): Promise<AccessItem | Response> {
  try {
    if (target.kind === "file") {
      const { data, error } = await registerFor(serviceClient, callerId, REGISTER_COLUMNS)
        .eq("record", target.record).eq("family_id", target.id).order("version", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as Row[];
      const latest = rows.find((r) => r.is_latest === true) ?? rows[0];
      if (!latest) return jsonResponse({ error: "Document not found." }, request, 404);
      const [where, first, canEdit] = await Promise.all([
        placeFor(serviceClient, callerId, latest.folder_id ? "folder" : String(target.record), String(latest.folder_id ?? latest.record_id)),
        // Whoever uploaded the file first is its uploader; a later version's doesn't make it theirs.
        serviceClient.from(REGISTER[String(target.record)].table).select("uploaded_by, access_by_admin").eq("family_id", target.id).order("version").limit(1).maybeSingle(),
        fileCanEdit(serviceClient, callerId, String(target.record), target.id),
      ]);
      if (first.error) throw first.error;
      return {
        target,
        teamId: String(latest.team_id),
        restricted: latest.restricted === true,
        locked: latest.restricted === true || where?.locked === true,
        // Once an admin has chosen who sees the file, only admins change it.
        uploadedByCaller: first.data?.uploaded_by === callerId && first.data?.access_by_admin !== true,
        canEdit,
        file: latest,
      };
    }
    const place = await placeFor(serviceClient, callerId, target.kind, target.id);
    const refused = placeRefusal(place, "read", target.kind);
    if (refused || !place) return jsonResponse({ error: refused?.error ?? "Not found." }, request, refused?.status ?? 404);
    const { data, error } = await serviceClient.from(ITEM_TABLE[target.kind]).select("restricted").eq("id", target.id).maybeSingle();
    if (error) throw error;
    return { target, teamId: place.teamId, restricted: data?.restricted === true, locked: place.locked, uploadedByCaller: false, canEdit: place.canEdit, file: null };
  } catch (error) {
    return internalError(request, error, "read item");
  }
}

/**
 * GET ?kind=client|engagement|folder|file&id=&record=: whether an item is
 * locked, who is added to it, who it is shared with, and what the caller may
 * change. For a file, id is its family and record its table.
 */
async function handleAccess(reader: Reader, request: Request, params: URLSearchParams, caller: CallerTeams) {
  const { serviceClient, callerId } = reader;
  const target = parseAccessTarget({ kind: params.get("kind"), id: params.get("id"), record: params.get("record") });
  if ("error" in target) return jsonResponse({ error: target.error }, request, 400);
  const item = await accessItem(serviceClient, callerId, request, target);
  if (item instanceof Response) return item;
  const column = ITEM_COLUMN[target.kind];
  const [writeLevel, added, shares] = await Promise.all([
    callerLevel(serviceClient, callerId, ENTITY, "write"),
    serviceClient.from("document_access").select("profile_id, can_edit").eq(column, target.id),
    serviceClient.from("document_shares").select("id, profile_id, team_id, expires_at, shared_by, created_at").eq(column, target.id).order("created_at"),
  ]);
  if (added.error ?? shares.error) return internalError(request, added.error ?? shares.error, "read access");
  const people = (added.data ?? []) as Row[];
  const given = (shares.data ?? []) as Row[];
  const idsOf = (rows: Row[], key: string) => rows.map((r) => r[key]).filter((id): id is string => typeof id === "string");
  const teamIds = idsOf(given, "team_id");
  const [names, teams] = await Promise.all([
    buildDisplayNameMap(serviceClient, new Set([...idsOf(people, "profile_id"), ...idsOf(given, "profile_id"), ...idsOf(given, "shared_by")])),
    teamIds.length > 0 ? serviceClient.from("teams").select("id, name").in("id", teamIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (teams.error) return internalError(request, teams.error, "read teams");
  const teamNames = new Map(((teams.data ?? []) as Row[]).map((t) => [String(t.id), String(t.name)]));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const now = Date.now();
  const mayManage = mayManageAccess({
    globalAdmin: caller.globalAdmin,
    adminTeamIds: caller.adminTeamIds,
    teamId: item.teamId,
    uploadedByCaller: item.uploadedByCaller && writeLevel > 0,
  });
  // Who else is added or shared is for those who may change the item; everyone
  // else sees only their own way in.
  const seesAll = mayManage || item.canEdit;
  const mine = (personId: unknown, teamId: unknown) =>
    personId === callerId || (typeof teamId === "string" && caller.teamIds.includes(teamId));
  return jsonResponse({
    access: {
      kind: target.kind,
      id: target.id,
      record: target.record,
      restricted: item.restricted,
      locked: item.locked,
      people: people
        .filter((p) => seesAll || mine(p.profile_id, null))
        .map((p) => ({ personId: String(p.profile_id), name: names.get(String(p.profile_id)) ?? "Unknown", canEdit: p.can_edit === true }))
        .sort(byName),
      shares: given.filter((s) => seesAll || mine(s.profile_id, s.team_id)).map((s) => ({
        shareId: s.id,
        personId: s.profile_id ?? null,
        teamId: s.team_id ?? null,
        name: typeof s.team_id === "string" ? (teamNames.get(s.team_id) ?? "Unknown") : (names.get(String(s.profile_id)) ?? "Unknown"),
        expiresAt: s.expires_at ?? null,
        expired: typeof s.expires_at === "string" && Date.parse(s.expires_at) <= now,
        sharedByDisplayName: typeof s.shared_by === "string" ? (names.get(s.shared_by) ?? "Unknown") : null,
        canRemove: mayRemoveShare({
          callerId,
          sharedBy: typeof s.shared_by === "string" ? s.shared_by : null,
          globalAdmin: caller.globalAdmin,
          adminTeamIds: caller.adminTeamIds,
          teamId: item.teamId,
        }),
      })),
      // Locking it and choosing who is added.
      canEdit: mayManage,
      canShare: writeLevel > 0 && !item.locked && item.canEdit,
    },
  }, request);
}

// ---------------------------------------------------------------- mutations

interface MutationContext {
  serviceClient: ServiceClient;
  callerId: string;
  request: Request;
  payload: Record<string, unknown>;
  caller: CallerTeams;
}

/** The file a mutation names, or the response that refuses it. */
async function namedFile(ctx: MutationContext): Promise<{ row: Row; table: string } | Response> {
  const record = typeof ctx.payload.record === "string" ? ctx.payload.record : "";
  const documentId = typeof ctx.payload.documentId === "string" ? ctx.payload.documentId : "";
  if (!(record in REGISTER) || !isUuid(documentId)) return jsonResponse({ error: "Invalid document." }, ctx.request, 400);
  const { row, error } = await readRegisterRow(ctx.serviceClient, ctx.callerId, record, documentId);
  if (error) return internalError(ctx.request, error, "read document");
  // A file the caller doesn't see reads as not there.
  if (!row) return jsonResponse({ error: "Document not found." }, ctx.request, 404);
  return { row, table: REGISTER[record].table };
}

/** A file the caller may only view, as the response that refuses changing it; null when they may. */
async function viewOnlyRefusal(ctx: MutationContext, row: Row): Promise<Response | null> {
  try {
    if (await fileCanEdit(ctx.serviceClient, ctx.callerId, String(row.record), String(row.family_id))) return null;
  } catch (error) {
    return internalError(ctx.request, error, "read document access");
  }
  return jsonResponse({ error: VIEW_ONLY }, ctx.request, 403);
}

/** How the caller stands to a client, engagement or folder, or the response that refuses it. */
async function namedPlace(ctx: MutationContext, kind: string, id: string, intent: "read" | "write"): Promise<Place | Response> {
  let place: Place | null;
  try {
    place = await placeFor(ctx.serviceClient, ctx.callerId, kind, id);
  } catch (error) {
    return internalError(ctx.request, error, `read ${kind}`);
  }
  const refused = placeRefusal(place, intent, kind === "folder" ? "folder" : kind);
  if (refused || !place) return jsonResponse({ error: refused?.error ?? "Not found." }, ctx.request, refused?.status ?? 404);
  return place;
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
  const refused = await viewOnlyRefusal(ctx, file.row);
  if (refused) return refused;
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
  const viewOnly = await viewOnlyRefusal(ctx, row);
  if (viewOnly) return viewOnly;
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
  await logDocumentEvent(serviceClient, row, "submitted", callerId);
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
    if (waitingOn.length > 0 && !forGroup) {
      await logDocumentEvent(serviceClient, row, "approval_recorded", callerId, `${waitingOn.length} still to approve`);
      return jsonResponse({ message: "Approval recorded.", waitingOn: waitingOn.length }, request);
    }
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
  await logDocumentEvent(serviceClient, row, decision === "approved" ? "approved" : "sent_back", callerId, comment || null);
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
  const viewOnly = await viewOnlyRefusal(ctx, file.row);
  if (viewOnly) return viewOnly;
  const { error } = await serviceClient
    .from(file.table)
    .update({ on_hold: payload.onHold, hold_by: payload.onHold ? callerId : null, hold_at: payload.onHold ? new Date().toISOString() : null })
    .eq("id", file.row.id);
  if (error) return internalError(request, error, "hold document");
  await logDocumentEvent(serviceClient, file.row, payload.onHold ? "hold_set" : "hold_lifted", callerId);
  return jsonResponse({ message: payload.onHold ? "On hold." : "Hold lifted." }, request);
}

// ---------------------------------------------------------------- end of retention

/** A file past its retention is reviewed by whoever manages documents. Null to proceed. */
async function retentionReviewerRefusal(ctx: MutationContext): Promise<Response | null> {
  if ((await callerLevel(ctx.serviceClient, ctx.callerId, ENTITY, "delete")) >= LEVEL_ALL) return null;
  return jsonResponse({ error: "Only someone who can manage documents can dispose of a file or extend its retention." }, ctx.request, 403);
}

/**
 * POST { record, documentId, reason }: destroy a file whose retention has run
 * out, every version with it, and keep a line saying so for good.
 */
async function handleDispose(ctx: MutationContext): Promise<Response> {
  const { serviceClient, callerId, request, payload } = ctx;
  const refused = await retentionReviewerRefusal(ctx);
  if (refused) return refused;
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  if (!reason) return jsonResponse({ error: "Say why this file is being disposed of. The reason is kept on the disposal record." }, request, 400);
  if (reason.length > MAX_DISPOSAL_REASON) {
    return jsonResponse({ error: `The reason must be ${MAX_DISPOSAL_REASON} characters or fewer.` }, request, 400);
  }
  const file = await namedFile(ctx);
  if (file instanceof Response) return file;
  const { row, table } = file;
  const viewOnly = await viewOnlyRefusal(ctx, row);
  if (viewOnly) return viewOnly;

  const versions = await serviceClient.from(table).select("on_hold, retain_until").eq("family_id", row.family_id);
  if (versions.error) return internalError(request, versions.error, "read document versions");
  const kept = (v: Row) => ({ onHold: v.on_hold === true, retainUntil: typeof v.retain_until === "string" ? v.retain_until : null });
  const refusal = disposalRefusal(
    { ...kept(row), archived: !!row.archived_at, isLatest: row.is_latest === true },
    ((versions.data ?? []) as Row[]).map(kept),
    await orgToday(serviceClient),
  );
  if (refusal) return jsonResponse({ error: refusal }, request, 400);

  const names = await buildDisplayNameMap(serviceClient, new Set([callerId]));
  // The rows and the disposal line go together; the database still refuses a held or retained version.
  const { data: paths, error } = await serviceClient.rpc("dispose_document_family", {
    p_record: row.record,
    p_family_id: row.family_id,
    p_file_name: row.file_name,
    p_document_type: row.document_type,
    p_client_name: row.client_name,
    p_record_name: row.record_name,
    p_retained_until: row.retain_until,
    p_reason: reason,
    p_by: callerId,
    p_by_name: names.get(callerId) ?? "Unknown",
  });
  if (error) return internalError(request, error, "dispose of document");
  // A leftover object is invisible; the rows that pointed at it are gone.
  const { error: storageError } = await serviceClient.storage.from(REGISTER[String(row.record)].bucket).remove((paths ?? []) as string[]);
  if (storageError) console.error("dispose of document: stored file left behind", storageError.message);
  await logDocumentEvent(serviceClient, row, "disposed", callerId, reason);
  return jsonResponse({ message: "Document disposed of." }, request);
}

/** POST { record, documentId, retainUntil }: keep a file longer than its category said. */
async function handleExtendRetention(ctx: MutationContext): Promise<Response> {
  const { serviceClient, callerId, request, payload } = ctx;
  const refused = await retentionReviewerRefusal(ctx);
  if (refused) return refused;
  const file = await namedFile(ctx);
  if (file instanceof Response) return file;
  const { row, table } = file;
  const viewOnly = await viewOnlyRefusal(ctx, row);
  if (viewOnly) return viewOnly;
  const refusal = extensionRefusal(
    { archived: !!row.archived_at, retainUntil: typeof row.retain_until === "string" ? row.retain_until : null },
    payload.retainUntil,
    await orgToday(serviceClient),
  );
  if (refusal) return jsonResponse({ error: refusal }, request, 400);
  const { error } = await serviceClient.from(table).update({ retain_until: payload.retainUntil }).eq("id", row.id);
  if (error) return internalError(request, error, "extend retention");
  await logDocumentEvent(serviceClient, row, "retention_extended", callerId, `From ${row.retain_until} to ${payload.retainUntil}`);
  return jsonResponse({ message: "Retention extended." }, request);
}

// ---------------------------------------------------------------- folders

/** Folders are kept by whoever may change every document. Null to proceed. */
async function folderKeeperRefusal(ctx: MutationContext): Promise<Response | null> {
  if ((await callerLevel(ctx.serviceClient, ctx.callerId, ENTITY, "write")) >= LEVEL_ALL) return null;
  return jsonResponse({ error: "Only someone who can change every document can keep folders." }, ctx.request, 403);
}

/** The folder a mutation names, if the caller can edit it, or the response that refuses it. */
async function namedFolder(ctx: MutationContext, id: unknown): Promise<Row | Response> {
  if (typeof id !== "string" || !isUuid(id)) return jsonResponse({ error: "Invalid folder." }, ctx.request, 400);
  const place = await namedPlace(ctx, "folder", id, "write");
  if (place instanceof Response) return place;
  const { data, error } = await ctx.serviceClient
    .from("document_folders").select("id, client_id, engagement_id, parent_id, name").eq("id", id).maybeSingle();
  if (error) return internalError(ctx.request, error, "read folder");
  if (!data) return jsonResponse({ error: "Folder not found." }, ctx.request, 404);
  return data as Row;
}

const SAME_NAME = "A folder of that name is already here.";
const isDuplicate = (error: unknown) => (error as { code?: string } | null)?.code === "23505";

/** POST { record, recordId, parentId?, name }: a new folder on a client or
 *  an engagement, or inside one of its folders. */
async function handleCreateFolder(ctx: MutationContext): Promise<Response> {
  const { serviceClient, callerId, request, payload } = ctx;
  const refused = await folderKeeperRefusal(ctx);
  if (refused) return refused;
  const record = typeof payload.record === "string" ? payload.record : "";
  const recordId = typeof payload.recordId === "string" ? payload.recordId : "";
  if (!(record in REGISTER) || !isUuid(recordId)) return jsonResponse({ error: "Invalid record." }, request, 400);
  const parsed = parseFolderName(payload.name);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, request, 400);

  // It needs Can edit where it goes: the folder it sits in, or the record itself.
  let parentId: string | null = null;
  if (payload.parentId) {
    const parent = await namedFolder(ctx, payload.parentId);
    if (parent instanceof Response) return parent;
    // A folder sits inside a folder of the same record.
    if (parent[folderOwner(record)] !== recordId) return jsonResponse({ error: "That folder is on another record." }, request, 400);
    parentId = String(parent.id);
  } else {
    const place = await namedPlace(ctx, record, recordId, "write");
    if (place instanceof Response) return place;
  }

  const { data, error } = await serviceClient
    .from("document_folders")
    .insert({ [folderOwner(record)]: recordId, parent_id: parentId, name: parsed.name, created_by: callerId })
    .select("id")
    .single();
  if (isDuplicate(error)) return jsonResponse({ error: SAME_NAME }, request, 409);
  // The client or engagement named isn't there.
  if ((error as { code?: string } | null)?.code === "23503") return jsonResponse({ error: "Record not found." }, request, 404);
  if (error || !data) return internalError(request, error, "create folder");
  return jsonResponse({ message: "Folder created.", id: data.id }, request);
}

/** POST { folderId, name } */
async function handleRenameFolder(ctx: MutationContext): Promise<Response> {
  const { serviceClient, request, payload } = ctx;
  const refused = await folderKeeperRefusal(ctx);
  if (refused) return refused;
  const folder = await namedFolder(ctx, payload.folderId);
  if (folder instanceof Response) return folder;
  const parsed = parseFolderName(payload.name);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, request, 400);
  const { error } = await serviceClient.from("document_folders").update({ name: parsed.name }).eq("id", folder.id);
  if (isDuplicate(error)) return jsonResponse({ error: SAME_NAME }, request, 409);
  if (error) return internalError(request, error, "rename folder");
  return jsonResponse({ message: "Folder renamed." }, request);
}

/** POST { folderId }: only an empty folder goes. Removed files don't count;
 *  they fall back to the record. */
async function handleDeleteFolder(ctx: MutationContext): Promise<Response> {
  const { serviceClient, request, payload } = ctx;
  const refused = await folderKeeperRefusal(ctx);
  if (refused) return refused;
  const folder = await namedFolder(ctx, payload.folderId);
  if (folder instanceof Response) return folder;
  const table = REGISTER[folder.client_id ? "client" : "engagement"].table;
  const [folders, files] = await Promise.all([
    serviceClient.from("document_folders").select("id", { count: "exact", head: true }).eq("parent_id", folder.id),
    serviceClient.from(table).select("id", { count: "exact", head: true }).eq("folder_id", folder.id).is("archived_at", null),
  ]);
  if (folders.error ?? files.error) return internalError(request, folders.error ?? files.error, "read folder contents");
  const refusal = folderDeleteRefusal({ folders: folders.count ?? 0, files: files.count ?? 0 });
  if (refusal) return jsonResponse({ error: refusal }, request, 400);
  const { error } = await serviceClient.from("document_folders").delete().eq("id", folder.id);
  if (error) return internalError(request, error, "delete folder");
  return jsonResponse({ message: "Folder deleted." }, request);
}

/** The client or engagement a file is moving to, if the caller may add to it. */
async function fileableTarget(ctx: MutationContext, record: string, id: string): Promise<{ name: string; teamId: string } | Response> {
  const { serviceClient, callerId, request } = ctx;
  const [who, place] = await Promise.all([moverOf(serviceClient, callerId, ctx.caller), namedPlace(ctx, record, id, "read")]);
  if (place instanceof Response) return place;
  if (record === "client") {
    const { data, error } = await serviceClient.from("clients").select("name, created_by, archived_at").eq("id", id).maybeSingle();
    if (error) return internalError(request, error, "read client");
    if (!data) return jsonResponse({ error: "Client not found." }, request, 404);
    if (data.archived_at) return jsonResponse({ error: "That client is archived." }, request, 400);
    if (!mayFileOnClient(who, { createdBy: typeof data.created_by === "string" ? data.created_by : null, canEdit: place.canEdit })) {
      return jsonResponse({ error: "You cannot add files to that client." }, request, 403);
    }
    return { name: String(data.name), teamId: place.teamId };
  }
  const { data, error } = await serviceClient.from("engagements").select("name, team_id, archived_at, clients(archived_at)").eq("id", id).maybeSingle();
  if (error) return internalError(request, error, "read engagement");
  if (!data) return jsonResponse({ error: "Engagement not found." }, request, 404);
  if (data.archived_at || (data.clients as Row | null)?.archived_at) return jsonResponse({ error: "That engagement is archived." }, request, 400);
  if (!mayFileOnEngagement(who, { teamId: String(data.team_id), canEdit: place.canEdit })) {
    return jsonResponse({ error: "You cannot add files to that engagement." }, request, 403);
  }
  return { name: String(data.name), teamId: place.teamId };
}

/**
 * POST { record, documentId, folderId | null, to?: { record, recordId } }:
 * move a file, every version with it. Without `to` it stays on its record and
 * only changes folder. With one it goes to another client or engagement the
 * caller may add to, and its approval starts again there.
 */
async function handleMoveDocument(ctx: MutationContext): Promise<Response> {
  const { serviceClient, callerId, request, payload } = ctx;
  const perm = await requirePermission(serviceClient, callerId, ENTITY, "write");
  if (!perm.ok) return jsonResponse({ error: perm.error }, request, perm.status);
  const file = await namedFile(ctx);
  if (file instanceof Response) return file;
  const { row } = file;
  if (perm.level < LEVEL_ALL && row.uploaded_by !== callerId) {
    return jsonResponse({ error: "You can only move files you uploaded." }, request, 403);
  }
  const fromRecord = String(row.record);
  const to = payload.to && typeof payload.to === "object" ? payload.to as Row : null;
  const toRecord = to ? String(to.record) : fromRecord;
  const toId = to ? String(to.recordId) : String(row.record_id);
  if (!(toRecord in REGISTER) || !isUuid(toId)) return jsonResponse({ error: "Invalid destination." }, request, 400);
  const viewOnly = await viewOnlyRefusal(ctx, row);
  if (viewOnly) return viewOnly;
  // The name it goes by: its family's latest live version.
  const { data: latest, error: latestError } = await serviceClient
    .from(file.table).select("file_name").eq("family_id", row.family_id).is("archived_at", null)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  if (latestError) return internalError(request, latestError, "read document versions");
  const nameTaken = async (folder: string | null) =>
    !!latest && await fileNameTaken(serviceClient, REGISTER[toRecord], toId, folder, String(latest.file_name), String(row.family_id));

  let folderId: string | null = null;
  let folderName: string | null = null;
  if (payload.folderId !== null && payload.folderId !== undefined) {
    const folder = await namedFolder(ctx, payload.folderId);
    if (folder instanceof Response) return folder;
    if (folder[folderOwner(toRecord)] !== toId) {
      return jsonResponse({ error: "That folder is not on the place the file is going to." }, request, 400);
    }
    folderId = String(folder.id);
    folderName = String(folder.name);
  }

  try {
    if (await nameTaken(folderId)) return jsonResponse({ error: SAME_FILE_NAME }, request, 409);
  } catch (nameError) {
    return internalError(request, nameError, "check document name");
  }

  // Staying on its record, only the folder changes.
  if (toRecord === fromRecord && toId === row.record_id) {
    // Out of its folders, it sits on the record itself.
    if (!folderId) {
      const onRecord = await namedPlace(ctx, toRecord, toId, "write");
      if (onRecord instanceof Response) return onRecord;
    }
    const { error } = await serviceClient.from(file.table).update({ folder_id: folderId }).eq("family_id", row.family_id);
    if (error) return internalError(request, error, "move document");
    await logDocumentEvent(serviceClient, row, "moved", callerId, folderName ? `To ${folderName}` : "Out of its folder");
    return jsonResponse({ message: "Document moved." }, request);
  }

  const today = appToday(new Date(), (await loadOrgLocale(serviceClient)).timeZone);
  const stuck = leaveRefusal(
    { archived: !!row.archived_at, onHold: row.on_hold === true, retainUntil: typeof row.retain_until === "string" ? row.retain_until : null },
    today,
  );
  if (stuck) return jsonResponse({ error: stuck }, request, 400);
  const target = await fileableTarget(ctx, toRecord, toId);
  if (target instanceof Response) return target;
  const crossTeam = moveTeamRefusal(String(row.team_id), target.teamId, ctx.caller.globalAdmin);
  if (crossTeam) return jsonResponse({ error: crossTeam }, request, 403);
  let offered: readonly string[];
  try {
    offered = (await allowedDocumentTypes(serviceClient, toRecord as DocumentRecord, toId)).types;
  } catch (typesError) {
    return internalError(request, typesError, "read document categories");
  }
  if (!offered.includes(String(row.document_type))) {
    return jsonResponse({ error: `${row.document_type} is not a category offered on ${target.name}. Change the file's category first, then move it.` }, request, 400);
  }

  // A client's files and an engagement's are kept in different buckets, so
  // the stored versions go across first and come back if the rows don't follow.
  const source = REGISTER[fromRecord];
  const dest = REGISTER[toRecord];
  const crossed: string[] = [];
  const putBack = async () => {
    for (const path of crossed) {
      const { error } = await serviceClient.storage.from(dest.bucket).move(path, path, { destinationBucket: source.bucket });
      if (error) console.error("move document: could not put back", path, error.message);
    }
  };
  if (source.bucket !== dest.bucket) {
    const versions = await serviceClient.from(source.table).select("storage_path").eq("family_id", row.family_id);
    if (versions.error) return internalError(request, versions.error, "read document versions");
    for (const version of (versions.data ?? []) as Row[]) {
      const path = String(version.storage_path);
      const { error } = await serviceClient.storage.from(source.bucket).move(path, path, { destinationBucket: dest.bucket });
      if (error) {
        await putBack();
        return internalError(request, error, "move stored file");
      }
      crossed.push(path);
    }
  }
  const { error } = await serviceClient.rpc("move_document_family", {
    p_family: row.family_id,
    p_from: fromRecord,
    p_to: toRecord,
    p_to_id: toId,
    p_folder: folderId,
  });
  if (error) {
    await putBack();
    return internalError(request, error, "move document");
  }
  await logDocumentEvent(
    serviceClient,
    { ...row, record: toRecord },
    "moved",
    callerId,
    `From ${row.record_name} to ${target.name}${folderName ? `, ${folderName}` : ""}. Approval starts again.`,
  );
  return jsonResponse({ message: "Document moved." }, request);
}

/**
 * POST { kind, id, record?, restricted, people: [{ personId, canEdit }] }:
 * lock an item or not, and replace who is added to it. For global admins and
 * the item's team admins; a file's uploader may do it for their own file.
 */
async function handleSetAccess(ctx: MutationContext): Promise<Response> {
  const { serviceClient, callerId, request, payload } = ctx;
  const target = parseAccessTarget(payload);
  if ("error" in target) return jsonResponse({ error: target.error }, request, 400);
  if (typeof payload.restricted !== "boolean") return jsonResponse({ error: "restricted must be true or false." }, request, 400);
  const people = parseAccessPeople(payload.people);
  if ("error" in people) return jsonResponse({ error: people.error }, request, 400);
  const item = await accessItem(serviceClient, callerId, request, target);
  if (item instanceof Response) return item;
  const writeLevel = await callerLevel(serviceClient, callerId, ENTITY, "write");
  const allowed = mayManageAccess({
    globalAdmin: ctx.caller.globalAdmin,
    adminTeamIds: ctx.caller.adminTeamIds,
    teamId: item.teamId,
    uploadedByCaller: item.uploadedByCaller && writeLevel > 0,
  });
  const byAdmin = ctx.caller.globalAdmin || (!!item.teamId && ctx.caller.adminTeamIds.includes(item.teamId));
  if (!allowed) {
    return jsonResponse({ error: "Only the team's admins or a global admin can lock this or choose who is added. A file's uploader can for their own file, until an admin has." }, request, 403);
  }

  const ids = people.map((p) => p.personId);
  if (ids.length > 0) {
    const { data, error } = await serviceClient.from("profiles").select("id").in("id", ids).eq("status", "active");
    if (error) return internalError(request, error, "read people");
    if ((data ?? []).length !== ids.length) return jsonResponse({ error: "Everyone added must be an active person." }, request, 400);
  }
  const { error } = await serviceClient.rpc("replace_document_access", {
    p_kind: target.kind,
    p_id: target.id,
    p_record: target.record,
    p_restricted: payload.restricted,
    p_people: ids,
    p_can_edit: people.map((p) => p.canEdit),
    p_by_admin: byAdmin,
  });
  if (error) return internalError(request, error, "save access");
  if (item.file) await logDocumentEvent(serviceClient, item.file, "access_changed", callerId, accessSummary(payload.restricted, ids.length));
  return jsonResponse({ message: "Access saved." }, request);
}

/**
 * POST { kind, id, record?, personId | teamId, expiresAt? }: share an item,
 * view only, until a day in the future or until taken back. Sharing with
 * someone it is already shared with changes the end date. A locked item, or
 * anything inside one, can't be shared.
 */
async function handleAddShare(ctx: MutationContext): Promise<Response> {
  const { serviceClient, callerId, request, payload } = ctx;
  const target = parseAccessTarget(payload);
  if ("error" in target) return jsonResponse({ error: target.error }, request, 400);
  const personId = isUuid(payload.personId) ? payload.personId : null;
  const teamId = isUuid(payload.teamId) ? payload.teamId : null;
  if ((personId === null) === (teamId === null)) return jsonResponse({ error: "Share with one person or one team." }, request, 400);
  if (personId === callerId) return jsonResponse({ error: "You can't share an item with yourself." }, request, 400);
  const expiry = parseShareExpiry(payload.expiresAt, new Date());
  if (!expiry.ok) return jsonResponse({ error: expiry.error }, request, 400);
  if ((await callerLevel(serviceClient, callerId, ENTITY, "write")) === 0) {
    return jsonResponse({ error: "You don't have permission to share documents." }, request, 403);
  }
  const item = await accessItem(serviceClient, callerId, request, target);
  if (item instanceof Response) return item;
  // Sharing, or changing a share's end, is for those who can edit the item
  // (its team admins and global admins always can), never a sharee passing it on.
  if (!item.canEdit) return jsonResponse({ error: "Only someone who can edit this can share it." }, request, 403);
  if (item.locked) return jsonResponse({ error: LOCKED_SHARE }, request, 400);

  const who = personId
    ? await serviceClient.from("profiles").select("id").eq("id", personId).eq("status", "active").maybeSingle()
    : await serviceClient.from("teams").select("id, name").eq("id", teamId).maybeSingle();
  if (who.error) return internalError(request, who.error, "read share");
  if (!who.data) return jsonResponse({ error: personId ? "Share with an active person." : "That team does not exist." }, request, 400);

  const column = ITEM_COLUMN[target.kind];
  const { data: existing, error: existingError } = await serviceClient
    .from("document_shares").select("id").eq(column, target.id).eq(personId ? "profile_id" : "team_id", personId ?? teamId).limit(1).maybeSingle();
  if (existingError) return internalError(request, existingError, "read share");
  const { data: saved, error } = existing
    ? await serviceClient.from("document_shares").update({ expires_at: expiry.expiresAt, shared_by: callerId }).eq("id", existing.id).select("id").single()
    : await serviceClient.from("document_shares")
      .insert({ [column]: target.id, profile_id: personId, team_id: teamId, expires_at: expiry.expiresAt, shared_by: callerId })
      .select("id").single();
  if (error || !saved) return internalError(request, error, "save share");
  if (item.file) {
    const name = personId ? ((await buildDisplayNameMap(serviceClient, new Set([personId]))).get(personId) ?? "Unknown") : String(who.data.name);
    await logDocumentEvent(serviceClient, item.file, "access_changed", callerId,
      `Shared with ${name}${expiry.expiresAt ? ` until ${expiry.expiresAt.slice(0, 10)}` : ""}`);
  }
  return jsonResponse({ message: "Shared.", shareId: saved.id }, request);
}

/** POST { shareId }: take a share back. For whoever gave it, the item's team admins and global admins. */
async function handleRemoveShare(ctx: MutationContext): Promise<Response> {
  const { serviceClient, callerId, request, payload } = ctx;
  if (!isUuid(payload.shareId)) return jsonResponse({ error: "Invalid share." }, request, 400);
  const { data: share, error } = await serviceClient
    .from("document_shares").select("id, client_id, engagement_id, folder_id, family_id, shared_by").eq("id", payload.shareId).maybeSingle();
  if (error) return internalError(request, error, "read share");
  if (!share) return jsonResponse({ error: "Share not found." }, request, 404);

  // The item's team, and for a file a version to write its history against.
  let teamId: string | null = null;
  let file: Row | null = null;
  if (typeof share.family_id === "string") {
    const { data, error: fileError } = await serviceClient
      .from("document_register").select("id, record, family_id, file_name, team_id").eq("family_id", share.family_id).eq("is_latest", true).limit(1).maybeSingle();
    if (fileError) return internalError(request, fileError, "read share");
    file = (data as Row | null) ?? null;
    teamId = typeof file?.team_id === "string" ? file.team_id : null;
  } else {
    const kind = share.client_id ? "client" : share.engagement_id ? "engagement" : "folder";
    const place = await placeFor(serviceClient, callerId, kind, String(share.client_id ?? share.engagement_id ?? share.folder_id));
    teamId = place?.teamId ?? null;
  }
  const allowed = mayRemoveShare({
    callerId,
    sharedBy: typeof share.shared_by === "string" ? share.shared_by : null,
    globalAdmin: ctx.caller.globalAdmin,
    adminTeamIds: ctx.caller.adminTeamIds,
    teamId,
  });
  if (!allowed) return jsonResponse({ error: "Only the person who shared it, the team's admins or a global admin can take a share back." }, request, 403);
  const { error: deleteError } = await serviceClient.from("document_shares").delete().eq("id", share.id);
  if (deleteError) return internalError(request, deleteError, "remove share");
  if (file) await logDocumentEvent(serviceClient, file, "access_changed", callerId, "A share was taken back");
  return jsonResponse({ message: "Share removed." }, request);
}

/** POST { record, recordId }: give a client or engagement the folders of its
 *  template, leaving the folders it has. */
async function handleApplyTemplate(ctx: MutationContext): Promise<Response> {
  const { serviceClient, callerId, request, payload } = ctx;
  const refused = await folderKeeperRefusal(ctx);
  if (refused) return refused;
  const record = typeof payload.record === "string" ? payload.record : "";
  const recordId = typeof payload.recordId === "string" ? payload.recordId : "";
  if ((record !== "client" && record !== "engagement") || !isUuid(recordId)) return jsonResponse({ error: "Invalid record." }, request, 400);
  const place = await namedPlace(ctx, record, recordId, "write");
  if (place instanceof Response) return place;

  const { data: found, error } = record === "engagement"
    ? await serviceClient.from("engagements").select("id, team_id, engagement_type_id").eq("id", recordId).maybeSingle()
    : await serviceClient.from("clients").select("id").eq("id", recordId).maybeSingle();
  if (error) return internalError(request, error, "read record");
  if (!found) return jsonResponse({ error: "Record not found." }, request, 404);
  const of = found as Row;
  try {
    const made = await addTemplateFolders(serviceClient, record, recordId, callerId, {
      teamId: typeof of.team_id === "string" ? of.team_id : null,
      engagementTypeId: typeof of.engagement_type_id === "string" ? of.engagement_type_id : null,
    });
    if (made === null) return jsonResponse({ error: "There is no folder template for this. Add one in Settings, under Folder Templates." }, request, 400);
    return jsonResponse({ message: made === 0 ? "It already has every folder of its template." : "Folders added.", created: made }, request);
  } catch (applyError) {
    return internalError(request, applyError, "apply folder template");
  }
}

// Each action and its handler. Every one checks its own grant, because they
// differ: details need Documents write, a decision needs the approval right.
const MUTATIONS: Record<string, (ctx: MutationContext) => Promise<Response>> = {
  update: handleUpdate,
  submit: handleSubmit,
  decide: handleDecide,
  set_hold: handleSetHold,
  dispose: handleDispose,
  extend_retention: handleExtendRetention,
  create_folder: handleCreateFolder,
  rename_folder: handleRenameFolder,
  delete_folder: handleDeleteFolder,
  move_document: handleMoveDocument,
  set_access: handleSetAccess,
  add_share: handleAddShare,
  remove_share: handleRemoveShare,
  apply_folder_template: handleApplyTemplate,
};

Deno.serve((request) =>
  withAuthorizedCaller(request, async ({ request, serviceClient, callerId }) => {
    // Reading is the floor for everything here, a decision included.
    const perm = await requirePermission(serviceClient, callerId, ENTITY, "read");
    if (!perm.ok) return jsonResponse({ error: perm.error }, request, perm.status);

    if (request.method === "GET") {
      const params = new URL(request.url).searchParams;
      const teamId = teamParam(params);
      if (teamId === false) return jsonResponse({ error: "Invalid teamId." }, request, 400);
      const caller = await callerTeams(serviceClient, callerId);
      const reader: Reader = {
        serviceClient,
        callerId,
        // Own: the files you uploaded, and what you are added to or shared.
        ownUploader: perm.level === LEVEL_OWN ? callerId : null,
        reach: await loadReach(serviceClient, callerId, caller),
        teamId,
      };
      const action = params.get("action") ?? "list";
      if (action === "move_targets") return handleMoveTargets(reader, request, caller);
      if (action === "list" && params.get("removed") === "true") {
        const scope = binScope(perm.level, await callerLevel(serviceClient, callerId, ENTITY, "delete"), callerId);
        if (!scope.ok) return jsonResponse({ error: scope.error }, request, 403);
        return handleList({ ...reader, ownUploader: scope.uploader }, request, params, true);
      }
      if (action === "bin_tree") {
        const scope = binScope(perm.level, await callerLevel(serviceClient, callerId, ENTITY, "delete"), callerId);
        if (!scope.ok) return jsonResponse({ error: scope.error }, request, 403);
        return handleBinTree(reader, request, scope.uploader);
      }
      if (action === "list") return handleList(reader, request, params);
      if (action === "facets") return handleFacets(reader, request);
      if (action === "folders") return handleFolders(reader, request, params);
      if (action === "all_folders") return handleAllFolders(reader, request);
      if (action === "versions") return handleVersions(reader, request, params);
      if (action === "dashboard") return handleDashboard(reader, request);
      if (action === "approval") return handleApproval(reader, request, params, perm.level);
      if (action === "document_url") return handleUrl(reader, request, params, perm.level);
      if (action === "history") return handleHistory(reader, request, params);
      if (action === "access") return handleAccess(reader, request, params, caller);
      if (action === "disposals") return handleDisposals(serviceClient, request, params, callerId);
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
    return handler({ serviceClient, callerId, request, payload, caller: await callerTeams(serviceClient, callerId) });
  }));
