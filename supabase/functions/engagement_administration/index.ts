import { internalError, jsonResponse } from "../_shared/http.ts";
import { withAuthorizedCaller } from "../_shared/serve.ts";
import type { ServiceClient } from "../_shared/service-client.ts";
import { isUuid } from "../_shared/validation.ts";
import { buildDisplayNameMap } from "../_shared/display-names.ts";
import {
  type CallerTeams,
  engagementArchiveError,
  engagementInputError,
  engagementWriteError,
  normalizeEngagementStatus,
} from "../_shared/engagement-rules.ts";
import { selectAllRows } from "../_shared/paging.ts";
import { type DocumentEntityConfig, handleDeleteDocument as sharedDeleteDocument, handleDocumentUploadUrl as sharedDocumentUploadUrl, handleDocumentUrl as sharedDocumentUrl, handleListDocuments as sharedListDocuments, handlePurgeDocument as sharedPurgeDocument, handleRegisterDocument as sharedRegisterDocument, handleRestoreDocument as sharedRestoreDocument, handleUpdateDocument as sharedUpdateDocument } from "../_shared/document-handlers.ts";
import { callerTeams, LEVEL_OWN, requirePermission, type AccessAction } from "../_shared/permissions.ts";
import { RATE_LIMIT_RESPONSE, takeRateLimitToken } from "../_shared/rate-limit.ts";
import { isLiveEntityOf } from "../_shared/legal-entities.ts";
import { isOffered } from "../_shared/list-links.ts";
import { effectiveCountry, loadOrgLocale } from "../_shared/organisation-locale.ts";

// Engagements
// An engagement belongs to a client and has an owning team and a type from
// engagement_types. On top of the access role, only the owning team's members
// create or change one, and only its team admins archive it. Own on
// Engagements means engagements a team of yours owns.

type EngagementContext = {
  serviceClient: ServiceClient;
  callerId: string;
  teams: CallerTeams;
  /** Set at Own level: only engagements a team of the caller's owns. */
  ownOnly?: boolean;
};

type EngagementRow = {
  id: string;
  clientId: string;
  teamId: string;
  isArchived: boolean;
  clientArchived: boolean;
};

async function getEngagement(
  serviceClient: ServiceClient,
  engagementId: string,
): Promise<EngagementRow | { error: string; statusCode: number }> {
  const { data, error } = await serviceClient
    .from("engagements")
    .select("id, client_id, team_id, archived_at, clients!inner(archived_at)")
    .eq("id", engagementId)
    .maybeSingle();
  if (error) {
    // Log the real failure server-side; Postgres error text leaks schema detail
    // and mustn't reach the browser.
    console.error(`getEngagement: ${error.message}`);
    return { error: "Unable to load the engagement.", statusCode: 500 };
  }
  if (!data) return { error: "Engagement not found.", statusCode: 404 };
  const client = data.clients as unknown as { archived_at: string | null };
  return {
    id: String(data.id),
    clientId: String(data.client_id),
    teamId: String(data.team_id),
    isArchived: data.archived_at !== null,
    clientArchived: client.archived_at !== null,
  };
}

/** The client, type and team an engagement points at all exist and are
 *  usable; else the refusal message. */
async function referencesError(
  serviceClient: ServiceClient,
  input: { clientId: string; engagementTypeId: string; teamId: string },
): Promise<{ error: string; statusCode: number } | null> {
  const [client, type, team] = await Promise.all([
    serviceClient.from("clients").select("archived_at").eq("id", input.clientId).maybeSingle(),
    serviceClient.from("engagement_types").select("is_active").eq("id", input.engagementTypeId).maybeSingle(),
    serviceClient.from("teams").select("id, is_active").eq("id", input.teamId).maybeSingle(),
  ]);
  if (client.error || type.error || team.error) {
    console.error("referencesError:", client.error?.message ?? type.error?.message ?? team.error?.message);
    return { error: "Unable to check the engagement's client, type and team.", statusCode: 500 };
  }
  if (!client.data) return { error: "Client not found.", statusCode: 404 };
  if (client.data.archived_at) return { error: "Restore the client before adding or changing its engagements.", statusCode: 400 };
  if (!type.data) return { error: "That engagement type does not exist.", statusCode: 400 };
  if (!type.data.is_active) return { error: "That engagement type is no longer in use.", statusCode: 400 };
  if (!team.data) return { error: "That team does not exist.", statusCode: 400 };
  if (team.data.is_active === false) return { error: "That team is inactive. Pick an active team.", statusCode: 400 };
  return null;
}

/** Why this type can't be used by this team, or null. Nothing listed for a
 *  type means every business unit. */
async function typeOfferError(serviceClient: ServiceClient, typeId: string, teamId: string): Promise<string | null> {
  const [links, team] = await Promise.all([
    serviceClient.from("engagement_type_business_units").select("business_unit_id").eq("engagement_type_id", typeId),
    serviceClient.from("teams").select("business_unit_id").eq("id", teamId).maybeSingle(),
  ]);
  if (links.error || team.error) return "Unable to check the engagement type against the team's business unit.";
  const limit = (links.data ?? []).map((l: { business_unit_id: string }) => l.business_unit_id);
  const unitId = typeof team.data?.business_unit_id === "string" ? team.data.business_unit_id : null;
  return isOffered(limit, unitId) ? null : "That engagement type is not offered to that team's business unit.";
}

/** The entities an engagement names are live and on the right side: ours, and
 *  one of this client's. One it already names passes even if since switched
 *  off, so an unrelated edit doesn't trip on it. */
async function entityChoiceError(
  serviceClient: ServiceClient,
  clientId: string,
  fields: { ourEntityId: string; clientEntityId: string },
  current: { our: string | null; theirs: string | null } = { our: null, theirs: null },
): Promise<string | null> {
  if (fields.ourEntityId && fields.ourEntityId !== current.our && !(await isLiveEntityOf(serviceClient, fields.ourEntityId, null))) {
    return "That is not one of our live entities.";
  }
  if (
    fields.clientEntityId && fields.clientEntityId !== current.theirs &&
    !(await isLiveEntityOf(serviceClient, fields.clientEntityId, clientId))
  ) {
    return "That entity is not one of this client's live entities.";
  }
  return null;
}

function fieldsFrom(payload: Record<string, unknown>) {
  const text = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string).trim() : "");
  return {
    engagementName: text("engagementName"),
    engagementTypeId: text("engagementTypeId"),
    teamId: text("teamId"),
    startDate: text("startDate"),
    endDate: text("endDate"),
    countryCode: text("countryCode").toUpperCase(),
    reference: text("reference"),
    description: text("description"),
    // Who the contract is between; "" means the default.
    ourEntityId: text("ourEntityId"),
    clientEntityId: text("clientEntityId"),
  };
}

async function handleListEngagements(ctx: EngagementContext, request: Request, url: URL): Promise<Response> {
  const { serviceClient } = ctx;

  const clientId = url.searchParams.get("clientId") ?? "";
  if (clientId && !isUuid(clientId)) {
    return jsonResponse({ error: "Invalid clientId." }, request, 400);
  }
  if (ctx.ownOnly && ctx.teams.teamIds.length === 0) {
    return jsonResponse({ engagements: [] }, request);
  }

  // Paged: the whole book can pass PostgREST's 1,000-row cap.
  const { data: engagements, error } = await selectAllRows(() => {
    let query = serviceClient
      .from("engagements")
      .select(
        "id, client_id, name, status, start_date, end_date, country_code, reference, description, created_at, created_by, engagement_type_id, team_id, engagement_types!inner(name), teams!inner(name), clients!inner(archived_at), our_entity_id, client_entity_id, our:legal_entities!engagements_our_entity_id_fkey(registered_name), theirs:legal_entities!engagements_client_entity_id_fkey(registered_name)",
      )
      // Archived engagements are history, never listed.
      .is("archived_at", null);
    // One client's engagements show even when it's archived (browsing it); the
    // whole book leaves an archived client's engagements out.
    if (clientId) query = query.eq("client_id", clientId);
    else query = query.is("clients.archived_at", null);
    if (ctx.ownOnly) query = query.in("team_id", [...ctx.teams.teamIds]);
    return query.order("start_date", { ascending: false }).order("id");
  });

  if (error) {
    return internalError(request, error);
  }

  const userIds = new Set<string>();
  for (const e of engagements) {
    if (typeof e.created_by === "string" && e.created_by) userIds.add(e.created_by);
  }
  const displayNameById = await buildDisplayNameMap(serviceClient, userIds);
  const str = (value: unknown) => (typeof value === "string" ? value : "");

  return jsonResponse({
    engagements: engagements.map((e) => ({
      id: str(e.id),
      clientId: str(e.client_id),
      engagementName: str(e.name),
      status: normalizeEngagementStatus(e.status) ?? "prospective",
      startDate: str(e.start_date),
      endDate: str(e.end_date),
      engagementTypeId: str(e.engagement_type_id),
      engagementTypeName: str((e.engagement_types as { name?: unknown } | null)?.name),
      teamId: str(e.team_id),
      teamName: str((e.teams as { name?: unknown } | null)?.name),
      // Null: the team's default (ours) and the client's default (theirs).
      ourEntityId: typeof e.our_entity_id === "string" ? e.our_entity_id : null,
      ourEntityName: str((e.our as { registered_name?: unknown } | null)?.registered_name),
      clientEntityId: typeof e.client_entity_id === "string" ? e.client_entity_id : null,
      clientEntityName: str((e.theirs as { registered_name?: unknown } | null)?.registered_name),
      countryCode: str(e.country_code).trim(),
      reference: str(e.reference),
      description: str(e.description),
      createdAtUtc: str(e.created_at),
      createdByDisplayName: typeof e.created_by === "string"
        ? (displayNameById.get(e.created_by) ?? "Unknown")
        : "Unknown",
    })),
  }, request);
}

async function handleCreateEngagement(
  ctx: EngagementContext,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const { serviceClient, callerId } = ctx;
  const clientId = typeof payload.clientId === "string" ? payload.clientId.trim() : "";
  const fields = fieldsFrom(payload);
  // Locked to one country, the organisation's is the only one saved.
  fields.countryCode = effectiveCountry(fields.countryCode, await loadOrgLocale(serviceClient));
  const status = normalizeEngagementStatus(payload.status) ?? "prospective";
  if (payload.status !== undefined && normalizeEngagementStatus(payload.status) === null) {
    return jsonResponse({ error: "Invalid engagement status." }, request, 400);
  }

  if (!clientId || !fields.engagementName || !fields.engagementTypeId || !fields.teamId || !fields.startDate || !fields.endDate) {
    return jsonResponse(
      { error: "clientId, engagementName, engagementTypeId, teamId, startDate, and endDate are required." },
      request,
      400,
    );
  }
  if (!isUuid(clientId) || !isUuid(fields.engagementTypeId) || !isUuid(fields.teamId)) {
    return jsonResponse({ error: "Invalid clientId, engagementTypeId or teamId." }, request, 400);
  }

  // The shared rules, same as update.
  const inputError = engagementInputError(fields);
  if (inputError) return jsonResponse({ error: inputError }, request, 400);
  const teamError = engagementWriteError(ctx.teams, fields.teamId);
  if (teamError) return jsonResponse({ error: teamError }, request, 403);
  const refError = await referencesError(serviceClient, { clientId, ...fields });
  if (refError) return jsonResponse({ error: refError.error }, request, refError.statusCode);
  const offerError = await typeOfferError(serviceClient, fields.engagementTypeId, fields.teamId);
  if (offerError) return jsonResponse({ error: offerError }, request, 400);
  const entityError = await entityChoiceError(serviceClient, clientId, fields);
  if (entityError) return jsonResponse({ error: entityError }, request, 400);

  const { data: org, error: orgError } = await serviceClient
    .from("organisations").select("id").order("created_at").limit(1).single();
  if (orgError) return internalError(request, orgError, "organisation");

  const { data: createdEngagement, error } = await serviceClient
    .from("engagements")
    .insert({
      organisation_id: org.id,
      client_id: clientId,
      team_id: fields.teamId,
      engagement_type_id: fields.engagementTypeId,
      name: fields.engagementName,
      status,
      start_date: fields.startDate,
      end_date: fields.endDate,
      country_code: fields.countryCode,
      reference: fields.reference,
      our_entity_id: fields.ourEntityId || null,
      client_entity_id: fields.clientEntityId || null,
      description: fields.description,
      created_by: callerId,
    })
    .select("id")
    .single();

  if (error) {
    return internalError(request, error);
  }

  return jsonResponse({
    message: "Engagement created.",
    // Return the new id so the client doesn't have to re-list to find what it
    // just created.
    engagementId: typeof createdEngagement?.id === "string" ? createdEngagement.id : null,
  }, request);
}

async function handleUpdateEngagement(
  ctx: EngagementContext,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const { serviceClient } = ctx;
  const engagementId = typeof payload.engagementId === "string" ? payload.engagementId.trim() : "";
  const fields = fieldsFrom(payload);
  // Locked to one country, the organisation's is the only one saved.
  fields.countryCode = effectiveCountry(fields.countryCode, await loadOrgLocale(serviceClient));
  const status = normalizeEngagementStatus(payload.status);

  if (!engagementId || !fields.engagementName || !fields.engagementTypeId || !fields.teamId || !fields.startDate || !fields.endDate) {
    return jsonResponse(
      { error: "engagementId, engagementName, engagementTypeId, teamId, startDate, and endDate are required." },
      request,
      400,
    );
  }
  if (!isUuid(engagementId) || !isUuid(fields.engagementTypeId) || !isUuid(fields.teamId)) {
    return jsonResponse({ error: "Invalid engagementId, engagementTypeId or teamId." }, request, 400);
  }
  if (payload.status !== undefined && status === null) {
    return jsonResponse({ error: "Invalid engagement status." }, request, 400);
  }

  const inputError = engagementInputError(fields);
  if (inputError) return jsonResponse({ error: inputError }, request, 400);

  const existing = await getEngagement(serviceClient, engagementId);
  if ("error" in existing) return jsonResponse({ error: existing.error }, request, existing.statusCode);
  if (existing.isArchived) return jsonResponse({ error: "Cannot modify an archived engagement." }, request, 400);

  // The owning team changes it; moving it needs membership of both teams.
  const teamError = engagementWriteError(ctx.teams, existing.teamId) ?? engagementWriteError(ctx.teams, fields.teamId);
  if (teamError) return jsonResponse({ error: teamError }, request, 403);
  const refError = await referencesError(serviceClient, { clientId: existing.clientId, ...fields });
  if (refError) return jsonResponse({ error: refError.error }, request, refError.statusCode);
  const { data: chosen } = await serviceClient
    .from("engagements").select("our_entity_id, client_entity_id, engagement_type_id").eq("id", engagementId).maybeSingle();
  // The type it already has stays allowed; a new type or team is held to the business unit's list.
  if (chosen?.engagement_type_id !== fields.engagementTypeId || existing.teamId !== fields.teamId) {
    const offerError = await typeOfferError(serviceClient, fields.engagementTypeId, fields.teamId);
    if (offerError) return jsonResponse({ error: offerError }, request, 400);
  }
  const entityError = await entityChoiceError(serviceClient, existing.clientId, fields, {
    our: chosen?.our_entity_id ?? null,
    theirs: chosen?.client_entity_id ?? null,
  });
  if (entityError) return jsonResponse({ error: entityError }, request, 400);

  const updatePayload: Record<string, unknown> = {
    name: fields.engagementName,
    engagement_type_id: fields.engagementTypeId,
    team_id: fields.teamId,
    start_date: fields.startDate,
    end_date: fields.endDate,
    country_code: fields.countryCode,
    reference: fields.reference,
    our_entity_id: fields.ourEntityId || null,
    client_entity_id: fields.clientEntityId || null,
    description: fields.description,
    updated_at: new Date().toISOString(),
    updated_by: ctx.callerId,
  };
  if (status !== null) updatePayload.status = status;

  const { error } = await serviceClient.from("engagements").update(updatePayload).eq("id", engagementId);
  if (error) {
    return internalError(request, error);
  }
  return jsonResponse({ message: "Engagement updated." }, request);
}

// DELETE archives, never erases: an archived engagement leaves every list but
// keeps its files and history. The owning team's admins do it.
async function handleDeleteEngagement(
  ctx: EngagementContext,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const engagementId = typeof payload.engagementId === "string" ? payload.engagementId.trim() : "";
  if (!isUuid(engagementId)) {
    return jsonResponse({ error: "Invalid engagementId." }, request, 400);
  }

  const existing = await getEngagement(ctx.serviceClient, engagementId);
  if ("error" in existing) return jsonResponse({ error: existing.error }, request, existing.statusCode);
  if (existing.isArchived) return jsonResponse({ error: "Engagement is already archived." }, request, 400);
  const teamError = engagementArchiveError(ctx.teams, existing.teamId);
  if (teamError) return jsonResponse({ error: teamError }, request, 403);

  const { error } = await ctx.serviceClient
    .from("engagements")
    .update({ archived_at: new Date().toISOString(), updated_by: ctx.callerId })
    .eq("id", engagementId);
  if (error) return internalError(request, error);

  return jsonResponse({ message: "Engagement deleted." }, request);
}

// Engagement documents
// Bytes go to a private bucket and the browser never touches storage
// directly, so every read is a short-lived signed URL minted after the
// permission check.
const DOCUMENT_BUCKET = "engagement-documents";

// Through the shared handlers in _shared/document-handlers.ts.
function engagementDocumentConfig(ctx: EngagementContext): DocumentEntityConfig {
  return {
    table: "engagement_documents",
    idColumn: "engagement_id",
    bucket: DOCUMENT_BUCKET,
    entityLabel: "engagement",
    record: "engagement",
    checkAccess: async (engagementId, intent) => {
      if (!isUuid(engagementId)) return { error: "Invalid engagementId.", status: 400 };
      const engagement = await getEngagement(ctx.serviceClient, engagementId);
      if ("error" in engagement) return { error: engagement.error, status: engagement.statusCode };
      // At Own, an engagement's files follow the engagement: a team of yours.
      if (ctx.ownOnly && !ctx.teams.teamIds.includes(engagement.teamId)) {
        return { error: "That engagement is not one of your teams'.", status: 403 };
      }
      if (intent === "write") {
        if (engagement.isArchived) return { error: "Cannot modify an archived engagement.", status: 400 };
        if (engagement.clientArchived) return { error: "Restore the client before changing its files.", status: 400 };
        const teamError = engagementWriteError(ctx.teams, engagement.teamId);
        if (teamError) return { error: teamError, status: 403 };
      }
      return null;
    },
  };
}

type MutationRun = (ctx: EngagementContext, request: Request, payload: Record<string, unknown>) => Promise<Response>;

// One table binds each mutation to its permission.
const MUTATIONS: Record<string, { permission: AccessAction; run: MutationRun }> = {
  create: { permission: "write", run: handleCreateEngagement },
  update: { permission: "write", run: handleUpdateEngagement },
  delete: { permission: "delete", run: handleDeleteEngagement },
  // Two-step signed-URL upload.
  document_upload_url: {
    permission: "write",
    run: (ctx, request, payload) =>
      sharedDocumentUploadUrl(ctx, engagementDocumentConfig(ctx), request, { ...payload, entityId: payload.engagementId }),
  },
  register_document: {
    permission: "write",
    run: (ctx, request, payload) =>
      sharedRegisterDocument(ctx, engagementDocumentConfig(ctx), request, { ...payload, entityId: payload.engagementId }),
  },
  // Removing, restoring and erasing a file only need read on the record (editing
  // details still needs write, like uploading). The shared handler decides who
  // may (document-rules.ts), so an uploader without delete on the record and a
  // Documents manager without write on it can both get through.
  delete_document: {
    permission: "read",
    run: (ctx, request, payload) => sharedDeleteDocument(ctx, engagementDocumentConfig(ctx), request, payload),
  },
  update_document: {
    permission: "write",
    run: (ctx, request, payload) => sharedUpdateDocument(ctx, engagementDocumentConfig(ctx), request, payload),
  },
  restore_document: {
    permission: "read",
    run: (ctx, request, payload) => sharedRestoreDocument(ctx, engagementDocumentConfig(ctx), request, payload),
  },
  purge_document: {
    permission: "read",
    run: (ctx, request, payload) => sharedPurgeDocument(ctx, engagementDocumentConfig(ctx), request, payload),
  },
};

Deno.serve((request) =>
  withAuthorizedCaller(request, async ({ request, serviceClient, callerId }) => {
  const ctx: EngagementContext = {
    serviceClient,
    callerId,
    teams: await callerTeams(serviceClient, callerId),
  };

  /** 403 unless, at Own, the engagement in hand belongs to a team of the caller's. */
  async function denyIfNotOwnEngagement(engagementId: string): Promise<Response | null> {
    if (!ctx.ownOnly) return null;
    const engagement = await getEngagement(ctx.serviceClient, engagementId);
    if ("error" in engagement) return null; // the handler has a better 404
    if (ctx.teams.teamIds.includes(engagement.teamId)) return null;
    return jsonResponse({ error: "That engagement is not one of your teams'." }, request, 403);
  }

  // GET
  if (request.method === "GET") {
    const url = new URL(request.url);
    const action = (url.searchParams.get("action") ?? "").trim().toLowerCase();

    const perm = await requirePermission(ctx.serviceClient, ctx.callerId, "Engagements", "read");
    if (!perm.ok) return jsonResponse({ error: perm.error }, request, perm.status);
    ctx.ownOnly = perm.level === LEVEL_OWN;

    const namedEngagement = (url.searchParams.get("engagementId") ?? "").trim();
    if (namedEngagement && isUuid(namedEngagement)) {
      const denied = await denyIfNotOwnEngagement(namedEngagement);
      if (denied) return denied;
    }

    if (action === "documents") {
      return sharedListDocuments(ctx, engagementDocumentConfig(ctx), request, url.searchParams.get("engagementId") ?? "");
    }
    if (action === "document_url") {
      return sharedDocumentUrl(ctx, engagementDocumentConfig(ctx), request, url.searchParams.get("documentId") ?? "");
    }
    // Anything else falls through to the default listing by clientId.
    return handleListEngagements(ctx, request, url);
  }

  // Mutations
  // One rate-limit token per mutating request.
  const allowed = await takeRateLimitToken(ctx.serviceClient, `engagement:${ctx.callerId}`, 40, 0.5);
  if (!allowed) return jsonResponse({ error: RATE_LIMIT_RESPONSE.error }, request, RATE_LIMIT_RESPONSE.status);
  let payload: Record<string, unknown> = {};
  try {
    payload = await request.json();
  } catch {
    payload = {};
  }

  const action = typeof payload.action === "string" ? payload.action.trim().toLowerCase() : "";

  const mutation = Object.hasOwn(MUTATIONS, action) ? MUTATIONS[action] : undefined;
  if (!mutation) return jsonResponse({ error: `Unknown action: ${action}` }, request, 400);
  // The access role first; the team rules run inside the handlers, on top of it.
  const perm = await requirePermission(ctx.serviceClient, ctx.callerId, "Engagements", mutation.permission);
  if (!perm.ok) return jsonResponse({ error: perm.error }, request, perm.status);
  ctx.ownOnly = perm.level === LEVEL_OWN;

  const namedEngagement = typeof payload.engagementId === "string" ? payload.engagementId : "";
  if (namedEngagement && isUuid(namedEngagement)) {
    const denied = await denyIfNotOwnEngagement(namedEngagement);
    if (denied) return denied;
  }

  return mutation.run(ctx, request, payload);
  }));
