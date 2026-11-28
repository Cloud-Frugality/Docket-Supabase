import { internalError, jsonResponse } from "../_shared/http.ts";
import { withAuthorizedCaller } from "../_shared/serve.ts";
import { RATE_LIMIT_RESPONSE, takeRateLimitToken } from "../_shared/rate-limit.ts";
import type { ServiceClient } from "../_shared/service-client.ts";
import { buildDisplayNameMap } from "../_shared/display-names.ts";
import { isCountryCode, isDisplayName, isUuid, MAX_NAME, overMaxLength } from "../_shared/validation.ts";
import { INDUSTRIES, inVocabulary, vocabularyError } from "../_shared/vocabularies.ts";
import { callerTeams, LEVEL_OWN, requirePermission, type AccessAction } from "../_shared/permissions.ts";
import {
  type CallerTeams,
  clientCreateError,
  clientDeleteError,
  clientDetailsError,
  duplicateNameError,
} from "../_shared/engagement-rules.ts";
import { clientsFor, engagementsFor, placeFor, teamParam } from "../_shared/document-access-load.ts";
import { placeRefusal } from "../_shared/document-access.ts";
import { selectAllRows, selectForIds } from "../_shared/paging.ts";
import { listEntities, saveEntity } from "../_shared/legal-entities.ts";
import { effectiveCountry, loadOrgLocale } from "../_shared/organisation-locale.ts";
import { appToday } from "../_shared/app-date.ts";
import { applyFolderTemplate } from "../_shared/folder-template-apply.ts";
import { retentionRefusal } from "../_shared/file-approval.ts";
import {
  type DocumentEntityConfig,
  handleDeleteDocument,
  handleDocumentUploadUrl,
  handleDocumentUrl,
  handleListDocuments,
  handlePurgeDocument,
  handleRegisterDocument,
  handleRestoreDocument,
  handleUpdateDocument,
} from "../_shared/document-handlers.ts";

// Clients
// Each client is a team's, and is seen by the rule in SQL (clients_for and
// places_for): its team, global admins, and anyone added to or shared it. On
// top of the access role, a client is made by a member of its team, changed
// by whoever has Can edit on it, and deleted only by a global admin; everyone
// else archives. An archived client leaves the lists but its documents stay.

/** The client's optional details, trimmed. */
function detailsFrom(payload: Record<string, unknown>) {
  const text = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string).trim() : "");
  return {
    shortName: text("shortName"),
    primaryContactName: text("primaryContactName"),
    primaryContactEmail: text("primaryContactEmail").toLowerCase(),
  };
}

/**
 * The clients the caller sees, with their engagement counts, archived ones
 * included and flagged (the panel hides them unless asked). `createdBy`
 * narrows it at Own level, `teamId` to one team. Paged, because an unranged
 * read stops at 1,000.
 */
async function buildSnapshot(serviceClient: ServiceClient, callerId: string, createdBy: string | null, teamId: string | null) {
  const CLIENT_COLUMNS =
    "id, name, short_name, industry, country_code, primary_contact_name, primary_contact_email, archived_at, created_at, created_by, team_id, restricted, teams(name)";
  const { data: clients, error: clientError } = await selectAllRows(() => {
    let query = clientsFor(serviceClient, callerId, CLIENT_COLUMNS);
    if (createdBy) query = query.eq("created_by", createdBy);
    if (teamId) query = query.eq("team_id", teamId);
    return query.order("name", { ascending: true }).order("id");
  });

  if (clientError) {
    return { ok: false as const, error: "Unable to load clients." };
  }

  const userIds = new Set<string>();
  for (const client of clients) {
    if (typeof client.created_by === "string" && client.created_by) userIds.add(client.created_by);
  }

  // Both lookups only need the client rows, so they run together. Only 'active'
  // engagements count; archived ones are history.
  const clientIds = clients.map((c) => String(c.id));
  const [displayNameById, engagementCountResult] = await Promise.all([
    buildDisplayNameMap(serviceClient, userIds),
    // Only the engagements the caller sees are counted.
    selectForIds(clientIds, (chunk) =>
      engagementsFor(serviceClient, callerId, "id, client_id, status").is("archived_at", null).in("client_id", chunk).order("id")
    ),
  ]);

  if (engagementCountResult.error) {
    return { ok: false as const, error: "Unable to load engagement counts." };
  }

  const engagementCounts = new Map<string, { active: number; total: number }>();
  for (const row of engagementCountResult.data) {
    if (typeof row.client_id !== "string") continue;
    const counts = engagementCounts.get(row.client_id) ?? { active: 0, total: 0 };
    counts.total += 1;
    if (row.status === "active") counts.active += 1;
    engagementCounts.set(row.client_id, counts);
  }

  const str = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    ok: true as const,
    clients: clients.map((client) => ({
      id: str(client.id),
      activeEngagements: engagementCounts.get(str(client.id))?.active ?? 0,
      totalEngagements: engagementCounts.get(str(client.id))?.total ?? 0,
      clientName: str(client.name),
      shortName: str(client.short_name),
      industry: str(client.industry),
      countryCode: str(client.country_code),
      primaryContactName: str(client.primary_contact_name),
      primaryContactEmail: str(client.primary_contact_email),
      teamId: str(client.team_id),
      teamName: str((client.teams as { name?: unknown } | null)?.name),
      restricted: client.restricted === true,
      isArchived: client.archived_at !== null && client.archived_at !== undefined,
      createdAtUtc: str(client.created_at),
      createdByDisplayName: typeof client.created_by === "string"
        ? (displayNameById.get(client.created_by) ?? "Unknown")
        : "Unknown",
    })),
  };
}

type ClientContext = {
  serviceClient: ServiceClient;
  callerId: string;
  /** The caller's teams, for the team rules. */
  teams: CallerTeams;
  /** Set at Own level: Own on Clients is the clients you created. */
  ownOnly?: boolean;
};

/** Why the caller can't use this client, or null. Own on Clients is the clients you created. */
async function clientRefusal(ctx: ClientContext, clientId: string, intent: "read" | "write"): Promise<{ status: number; error: string } | null> {
  let place;
  try {
    place = await placeFor(ctx.serviceClient, ctx.callerId, "client", clientId);
  } catch (error) {
    console.error("client access:", (error as { message?: string }).message ?? error);
    return { status: 500, error: "Unable to read the client." };
  }
  const refused = placeRefusal(place, intent, "client");
  if (refused) return refused;
  if (ctx.ownOnly) {
    const { data } = await ctx.serviceClient.from("clients").select("created_by").eq("id", clientId).maybeSingle();
    if (data?.created_by !== ctx.callerId) return { status: 403, error: "That client is not yours." };
  }
  return null;
}

async function handleGetSnapshot(ctx: ClientContext, request: Request, teamId: string | null): Promise<Response> {
  const snapshot = await buildSnapshot(ctx.serviceClient, ctx.callerId, ctx.ownOnly ? ctx.callerId : null, teamId);
  if (!snapshot.ok) {
    return jsonResponse({ error: snapshot.error }, request, 500);
  }
  return jsonResponse({ clients: snapshot.clients }, request);
}

/** The shared field checks for create and update; the message on refusal. */
function clientInputError(
  clientName: string,
  industry: string,
  countryCode: string,
  details: ReturnType<typeof detailsFrom>,
): string | null {
  if (!clientName || !industry || !countryCode) return "clientName, industry, and countryCode are required.";
  if (!isDisplayName(clientName)) return "clientName must contain at least one letter or number.";
  if (overMaxLength(clientName, MAX_NAME)) return "clientName is too long.";
  if (!isCountryCode(countryCode)) return "countryCode must be two letters.";
  // industry is a Postgres enum: an unknown value would come back as an opaque
  // 500 instead of saying what was wrong.
  if (!inVocabulary(industry, INDUSTRIES)) return vocabularyError("industry", industry, INDUSTRIES);
  return clientDetailsError(details);
}

function fieldsFrom(payload: Record<string, unknown>) {
  return {
    clientName: typeof payload.clientName === "string" ? payload.clientName.trim() : "",
    industry: typeof payload.industry === "string" ? payload.industry.trim() : "",
    countryCode: typeof payload.countryCode === "string" ? payload.countryCode.trim().toUpperCase() : "",
    details: detailsFrom(payload),
  };
}

async function handleCreateClient(
  ctx: ClientContext,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const teamId = typeof payload.teamId === "string" ? payload.teamId.trim() : "";
  if (!isUuid(teamId)) return jsonResponse({ error: "Pick the team the client belongs to." }, request, 400);
  const teamError = clientCreateError(ctx.teams, teamId);
  if (teamError) return jsonResponse({ error: teamError }, request, 403);
  const { clientName, industry, countryCode: askedCountry, details } = fieldsFrom(payload);
  // Locked to one country, the organisation's is the only one saved.
  const countryCode = effectiveCountry(askedCountry, await loadOrgLocale(ctx.serviceClient));
  const inputError = clientInputError(clientName, industry, countryCode, details);
  if (inputError) return jsonResponse({ error: inputError }, request, 400);

  const [{ data: org, error: orgError }, { data: team, error: teamReadError }] = await Promise.all([
    ctx.serviceClient.from("organisations").select("id").order("created_at").limit(1).single(),
    ctx.serviceClient.from("teams").select("is_active").eq("id", teamId).maybeSingle(),
  ]);
  if (orgError ?? teamReadError) return internalError(request, orgError ?? teamReadError, "organisation");
  if (!team) return jsonResponse({ error: "That team does not exist." }, request, 400);
  if (team.is_active === false) return jsonResponse({ error: "That team is inactive. Pick an active team." }, request, 400);

  const { data: clientInsert, error: clientInsertError } = await ctx.serviceClient
    .from("clients")
    .insert({
      organisation_id: org.id,
      name: clientName,
      industry,
      country_code: countryCode,
      short_name: details.shortName,
      primary_contact_name: details.primaryContactName,
      primary_contact_email: details.primaryContactEmail,
      created_by: ctx.callerId,
      team_id: teamId,
    })
    .select("id")
    .single();

  const duplicate = duplicateNameError(clientInsertError);
  if (duplicate) return jsonResponse({ error: duplicate }, request, 409);
  if (clientInsertError || !clientInsert?.id) {
    return internalError(request, clientInsertError);
  }

  // Every client gets a default legal entity, named after it to start with, so
  // documents always have a registered name. If that fails the client is
  // removed rather than left half made.
  const entity = await saveEntity(ctx.serviceClient, String(clientInsert.id), {
    registeredName: clientName,
    countryCode,
  }, ctx.callerId);
  if (entity.status !== 200) {
    await ctx.serviceClient.from("clients").delete().eq("id", clientInsert.id);
    return jsonResponse({ error: "Unable to create the client's legal entity." }, request, 500);
  }

  await applyFolderTemplate(ctx.serviceClient, "client", String(clientInsert.id), ctx.callerId);

  // Return the id: a caller that opened this drawer to fill a picker needs to
  // know which client was made.
  return jsonResponse(
    { message: "Client created.", id: typeof clientInsert.id === "string" ? clientInsert.id : null },
    request,
  );
}

// Archive, or bring back: an archived client leaves every list and its
// engagements with it, but nothing is deleted and its documents stay.
async function handleSetClientArchived(
  ctx: ClientContext,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const clientId = typeof payload.clientId === "string" ? payload.clientId.trim() : "";
  if (!isUuid(clientId)) return jsonResponse({ error: "Invalid clientId." }, request, 400);
  const refused = await clientRefusal(ctx, clientId, "write");
  if (refused) return jsonResponse({ error: refused.error }, request, refused.status);
  const archived = payload.archived === true;

  const { data, error } = await ctx.serviceClient
    .from("clients")
    .update(archived
      ? { archived_at: new Date().toISOString(), archived_by: ctx.callerId }
      : { archived_at: null, archived_by: null })
    .eq("id", clientId)
    .select("id");
  if (error) return internalError(request, error);
  if ((data ?? []).length === 0) return jsonResponse({ error: "Client not found." }, request, 404);
  return jsonResponse({ message: archived ? "Client archived." : "Client restored." }, request);
}

async function handleUpdateClient(
  ctx: ClientContext,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const clientId = typeof payload.clientId === "string" ? payload.clientId.trim() : "";
  if (!isUuid(clientId)) return jsonResponse({ error: "Invalid clientId." }, request, 400);
  const refused = await clientRefusal(ctx, clientId, "write");
  if (refused) return jsonResponse({ error: refused.error }, request, refused.status);
  const { clientName, industry, countryCode: askedCountry, details } = fieldsFrom(payload);
  // Locked to one country, the organisation's is the only one saved.
  const countryCode = effectiveCountry(askedCountry, await loadOrgLocale(ctx.serviceClient));
  const inputError = clientInputError(clientName, industry, countryCode, details);
  if (inputError) return jsonResponse({ error: inputError }, request, 400);

  const { data: existing, error: readError } = await ctx.serviceClient
    .from("clients").select("archived_at").eq("id", clientId).maybeSingle();
  if (readError) return internalError(request, readError);
  if (!existing) return jsonResponse({ error: "Client not found." }, request, 404);
  if (existing.archived_at) return jsonResponse({ error: "Restore the client before changing it." }, request, 400);

  const { error } = await ctx.serviceClient.from("clients").update({
    name: clientName,
    industry,
    country_code: countryCode,
    short_name: details.shortName,
    primary_contact_name: details.primaryContactName,
    primary_contact_email: details.primaryContactEmail,
    updated_at: new Date().toISOString(),
    updated_by: ctx.callerId,
  }).eq("id", clientId);

  // Renaming onto another client's name in the team hits the same unique index.
  const duplicate = duplicateNameError(error);
  if (duplicate) return jsonResponse({ error: duplicate }, request, 409);
  if (error) {
    return internalError(request, error);
  }
  return jsonResponse({ message: "Client updated." }, request);
}

// Deleting outright is for global admins only; everyone else archives. Its
// engagements and every file under it go with it.
async function handleDeleteClient(
  ctx: ClientContext,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const teamError = clientDeleteError(ctx.teams);
  if (teamError) return jsonResponse({ error: teamError }, request, 403);
  const clientId = typeof payload.clientId === "string" ? payload.clientId.trim() : "";
  if (!isUuid(clientId)) {
    return jsonResponse({ error: "Invalid clientId." }, request, 400);
  }

  // The rows cascade with the client but the storage objects don't.
  const { data: documents } = await ctx.serviceClient
    .from("client_documents")
    .select("storage_path, on_hold, retain_until")
    .eq("client_id", clientId);
  const { data: engagementRows } = await ctx.serviceClient.from("engagements").select("id").eq("client_id", clientId);
  const engagementIds = (engagementRows ?? []).map((e) => String(e.id));
  const { data: engagementDocuments } = engagementIds.length
    ? await ctx.serviceClient.from("engagement_documents").select("storage_path, on_hold, retain_until").in("engagement_id", engagementIds)
    : { data: [] as Array<{ storage_path: string; on_hold: boolean; retain_until: string | null }> };

  // A held or retained file keeps its client: the database would refuse the
  // delete anyway, so say why first.
  const today = appToday(new Date(), (await loadOrgLocale(ctx.serviceClient)).timeZone);
  const kept = [...(documents ?? []), ...(engagementDocuments ?? [])]
    .filter((d) => retentionRefusal({ onHold: d.on_hold === true, retainUntil: d.retain_until ?? null }, today)).length;
  if (kept > 0) {
    return jsonResponse({
      error: `${kept} of this client's ${kept === 1 ? "files is" : "files are"} on hold or still retained, so it can't be deleted. Archive it instead.`,
    }, request, 400);
  }

  const { error } = await ctx.serviceClient.from("clients").delete().eq("id", clientId);
  if (error) {
    return internalError(request, error);
  }
  const paths = (documents ?? []).map((d) => String(d.storage_path));
  if (paths.length > 0) await ctx.serviceClient.storage.from("client-documents").remove(paths);
  const engagementPaths = (engagementDocuments ?? []).map((d) => String(d.storage_path));
  if (engagementPaths.length > 0) await ctx.serviceClient.storage.from("engagement-documents").remove(engagementPaths);

  return jsonResponse({ message: "Client deleted." }, request);
}

// A client's legal entities: the companies in its group a contract or invoice
// can be with. Changing them is changing the client, so they need what an
// update needs, and an archived client's stay as they were.
async function handleSaveEntity(
  ctx: ClientContext,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const clientId = typeof payload.clientId === "string" ? payload.clientId.trim() : "";
  if (!isUuid(clientId)) return jsonResponse({ error: "Invalid clientId." }, request, 400);
  const refused = await clientRefusal(ctx, clientId, "write");
  if (refused) return jsonResponse({ error: refused.error }, request, refused.status);
  const { data: client, error } = await ctx.serviceClient.from("clients").select("archived_at").eq("id", clientId).maybeSingle();
  if (error) return internalError(request, error);
  if (!client) return jsonResponse({ error: "Client not found." }, request, 404);
  if (client.archived_at) return jsonResponse({ error: "Restore the client before changing it." }, request, 400);
  const result = await saveEntity(ctx.serviceClient, clientId, payload, ctx.callerId);
  return jsonResponse(result.body, request, result.status);
}

// Client documents, through the shared handlers. Read needs Clients read and
// a client the caller sees; write needs Clients write and Can edit on it. At
// Own the client must be one the caller created, checked here because a
// delete names only the document.
function clientDocumentConfig(ctx: ClientContext): DocumentEntityConfig {
  return {
    table: "client_documents",
    idColumn: "client_id",
    bucket: "client-documents",
    entityLabel: "client",
    record: "client",
    checkAccess: async (clientId, intent) => {
      const refused = await clientRefusal(ctx, clientId, intent);
      if (refused) return refused;
      const { data, error } = await ctx.serviceClient.from("clients").select("archived_at").eq("id", clientId).maybeSingle();
      if (error) {
        console.error("client document access:", error.message);
        return { error: "Unable to read the client.", status: 500 };
      }
      if (!data) return { error: "Client not found.", status: 404 };
      // An archived client's files are kept and readable, not added to.
      if (intent === "write" && data.archived_at) {
        return { error: "Restore the client before changing its files.", status: 400 };
      }
      return null;
    },
  };
}

// One table binds each mutation to its permission.
// Every mutation here touches the Clients entity.
const MUTATIONS: Record<string, {
  permission: AccessAction;
  run: (ctx: ClientContext, request: Request, payload: Record<string, unknown>) => Promise<Response>;
}> = {
  create:       { permission: "write",  run: handleCreateClient },
  set_archived: { permission: "write",  run: handleSetClientArchived },
  update:       { permission: "write",  run: handleUpdateClient },
  delete:       { permission: "delete", run: handleDeleteClient },
  save_entity:  { permission: "write",  run: handleSaveEntity },
  document_upload_url: {
    permission: "write",
    run: (ctx, request, payload) =>
      handleDocumentUploadUrl(ctx, clientDocumentConfig(ctx), request, { ...payload, entityId: payload.clientId }),
  },
  register_document: {
    permission: "write",
    run: (ctx, request, payload) =>
      handleRegisterDocument(ctx, clientDocumentConfig(ctx), request, { ...payload, entityId: payload.clientId }),
  },
  // Removing, restoring and erasing a file only need read on the record (editing
  // details still needs write, like uploading). The shared handler decides who
  // may (document-rules.ts), so an uploader without delete on the record and a
  // Documents manager without write on it can both get through.
  delete_document: {
    permission: "read",
    run: (ctx, request, payload) => handleDeleteDocument(ctx, clientDocumentConfig(ctx), request, payload),
  },
  update_document: {
    permission: "write",
    run: (ctx, request, payload) => handleUpdateDocument(ctx, clientDocumentConfig(ctx), request, payload),
  },
  restore_document: {
    permission: "read",
    run: (ctx, request, payload) => handleRestoreDocument(ctx, clientDocumentConfig(ctx), request, payload),
  },
  purge_document: {
    permission: "read",
    run: (ctx, request, payload) => handlePurgeDocument(ctx, clientDocumentConfig(ctx), request, payload),
  },
};

Deno.serve((request) =>
  withAuthorizedCaller(request, async ({ request, serviceClient, callerId }) => {

    // One rate-limit token per mutating request.
    if (request.method !== "GET") {
      const allowed = await takeRateLimitToken(serviceClient, `client:${callerId}`, 40, 1);
      if (!allowed) return jsonResponse({ error: RATE_LIMIT_RESPONSE.error }, request, RATE_LIMIT_RESPONSE.status);
    }

  const ctx: ClientContext = {
    serviceClient,
    callerId,
    teams: await callerTeams(serviceClient, callerId),
  };

  // GET
  if (request.method === "GET") {
    // The snapshot is the Clients entity.
    const perm = await requirePermission(ctx.serviceClient, ctx.callerId, "Clients", "read");
    if (!perm.ok) return jsonResponse({ error: perm.error }, request, perm.status);
    ctx.ownOnly = perm.level === LEVEL_OWN;
    const url = new URL(request.url);
    const action = (url.searchParams.get("action") ?? "").trim().toLowerCase();
    if (action === "documents") {
      return handleListDocuments(ctx, clientDocumentConfig(ctx), request, url.searchParams.get("clientId") ?? "");
    }
    if (action === "document_url") {
      return handleDocumentUrl(ctx, clientDocumentConfig(ctx), request, url.searchParams.get("documentId") ?? "");
    }
    // One client's legal entities; at Own, a client the caller created.
    if (action === "entities") {
      const clientId = url.searchParams.get("clientId") ?? "";
      if (!isUuid(clientId)) return jsonResponse({ error: "Invalid clientId." }, request, 400);
      const refused = await clientRefusal(ctx, clientId, "read");
      if (refused) return jsonResponse({ error: refused.error }, request, refused.status);
      const result = await listEntities(ctx.serviceClient, clientId);
      return jsonResponse(result.body, request, result.status);
    }
    const teamId = teamParam(url.searchParams);
    if (teamId === false) return jsonResponse({ error: "Invalid teamId." }, request, 400);
    return handleGetSnapshot(ctx, request, teamId);
  }

  // Mutations
  let payload: Record<string, unknown> = {};
  try {
    payload = await request.json();
  } catch {
    payload = {};
  }

  const action = typeof payload.action === "string" ? payload.action.trim().toLowerCase() : "";

  const mutation = Object.hasOwn(MUTATIONS, action) ? MUTATIONS[action] : undefined;
  if (!mutation) return jsonResponse({ error: `Unknown action: ${action}` }, request, 400);

  // The access role first: write covers create and update, delete is its own
  // grant. The team rules run inside the handlers, on top of this.
  const perm = await requirePermission(ctx.serviceClient, ctx.callerId, "Clients", mutation.permission);
  if (!perm.ok) return jsonResponse({ error: perm.error }, request, perm.status);
  ctx.ownOnly = perm.level === LEVEL_OWN;

  // Each handler checks the client it names (clientRefusal); documents do it in checkAccess.
  return mutation.run(ctx, request, payload);
  }));
