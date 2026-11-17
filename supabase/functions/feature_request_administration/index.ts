import type { ServiceClient } from "../_shared/service-client.ts";
import { internalError, jsonResponse } from "../_shared/http.ts";
import { withAuthorizedCaller } from "../_shared/serve.ts";
import { RATE_LIMIT_RESPONSE, takeRateLimitToken } from "../_shared/rate-limit.ts";
import { selectAllRows } from "../_shared/paging.ts";
import { MAX_NAME, MAX_TEXT, isUuid, overMaxLength, pickFrom } from "../_shared/validation.ts";
import {
  BUG_LOCATIONS as AREAS,
  FEATURE_IMPACTS as IMPACTS,
  FEATURE_STATUSES as STATUSES,
  FEATURE_TYPES,
} from "../_shared/vocabularies.ts";
import { buildDisplayNameMap } from "../_shared/display-names.ts";
import { callerLevel, LEVEL_ALL, LEVEL_OWN, requirePermission, type AccessAction } from "../_shared/permissions.ts";
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

// Fixed vocabularies live in _shared/vocabularies.ts, drift-tested against
// src/lib/constants.ts. The area list is shared with bugs so both boards read
// the same.

// The board needs a short heading; take the description's first
// line, capped well under the name limit.
function titleFromDescription(description: string): string {
  const firstLine = description.trim().split("\n")[0].trim() || description.trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
}

// A request's attachments, through the shared handlers. Reading follows the
// board: Feature Requests read, and at Own only requests you raised. Changing
// them is for whoever raised the request, or someone with Feature Requests
// write at All, so the mutations gate on read and the rest is decided here,
// where a delete's parent is known.
function featureRequestDocumentConfig(
  serviceClient: ServiceClient,
  callerId: string,
  readOwnOnly: boolean,
): DocumentEntityConfig {
  return {
    table: "feature_request_documents",
    idColumn: "feature_request_id",
    bucket: "feature-request-documents",
    entityLabel: "feature request",
    record: "feature_request",
    checkAccess: async (featureRequestId, intent) => {
      const { data, error } = await serviceClient
        .from("feature_requests")
        .select("requested_by")
        .eq("id", featureRequestId)
        .maybeSingle();
      if (error) {
        console.error("feature request document access:", error.message);
        return { error: "Unable to read the feature request.", status: 500 };
      }
      if (!data) return { error: "Feature request not found.", status: 404 };
      const mine = data.requested_by === callerId;
      if (intent === "read") {
        return readOwnOnly && !mine ? { error: "That feature request is not yours.", status: 403 } : null;
      }
      if (mine) return null;
      const writeLevel = await callerLevel(serviceClient, callerId, "Feature Requests", "write");
      return writeLevel === LEVEL_ALL
        ? null
        : { error: "Only the person who raised this request can change its files.", status: 403 };
    },
  };
}

Deno.serve((request) =>
  withAuthorizedCaller(request, async ({ request, serviceClient, callerId }) => {

  // Reads
  if (request.method === "GET") {
    // The board is the Feature Requests entity.
    const perm = await requirePermission(serviceClient, callerId, "Feature Requests", "read");
    if (!perm.ok) return jsonResponse({ error: perm.error }, request, perm.status);

    const url = new URL(request.url);
    const readAction = (url.searchParams.get("action") ?? "").trim().toLowerCase();
    if (readAction === "documents" || readAction === "document_url") {
      const ctx = { serviceClient, callerId };
      const cfg = featureRequestDocumentConfig(serviceClient, callerId, perm.level === LEVEL_OWN);
      return readAction === "documents"
        ? handleListDocuments(ctx, cfg, request, url.searchParams.get("featureRequestId") ?? "")
        : handleDocumentUrl(ctx, cfg, request, url.searchParams.get("documentId") ?? "");
    }
    const statusFilter = pickFrom(url.searchParams.get("status"), STATUSES);

    let query = serviceClient
      .from("feature_requests")
      .select(
        "id, reference, title, area, feature_type, impact, description, description_original, status, vote_count, requested_by, created_at",
      )
      .order("vote_count", { ascending: false })
      .order("created_at", { ascending: false });
    if (statusFilter) query = query.eq("status", statusFilter);
    // Own: the requests this caller raised. A request belongs to the account that
    // made it, so requested_by is the whole answer.
    if (perm.level === LEVEL_OWN) query = query.eq("requested_by", callerId);

    // Paged: every request ever raised is in this list, and an unranged read would
    // quietly stop at 1,000.
    const { data: rows, error } = await selectAllRows(() => query.order("id"));
    if (error) return internalError(request, error, "feature request list");

    // Which of these the caller has voted for: one extra query, mapped in.
    const { data: myVotes, error: votesError } = await serviceClient
      .from("feature_request_votes")
      .select("feature_request_id")
      .eq("user_id", callerId);
    if (votesError) return internalError(request, votesError, "feature request votes");

    const voted = new Set((myVotes ?? []).map((v) => v.feature_request_id as string));

    // Resolve requester ids to display names in one go so the feed shows names,
    // not raw ids.
    const requesterIds = new Set<string>();
    for (const r of rows ?? []) {
      if (typeof r.requested_by === "string" && r.requested_by) requesterIds.add(r.requested_by);
    }
    const nameById = await buildDisplayNameMap(serviceClient, requesterIds);

    const items = (rows ?? []).map((r) => ({
      id: r.id,
      reference: r.reference,
      title: r.title,
      area: r.area,
      featureType: r.feature_type,
      impact: r.impact,
      description: r.description,
      descriptionOriginal: r.description_original,
      status: r.status,
      voteCount: r.vote_count,
      requestedBy: r.requested_by,
      requestedByName: r.requested_by ? (nameById.get(r.requested_by as string) ?? null) : null,
      createdAt: r.created_at,
      hasVoted: voted.has(r.id as string),
    }));

    return jsonResponse({ items }, request);
  }

  // Mutations
  // One rate-limit token per mutating request. Votes click fast, so the bucket
  // is looser than bug reports: 15 burst, one per 2s.
  {
    const allowed = await takeRateLimitToken(serviceClient, `feature:${callerId}`, 15, 0.5);
    if (!allowed) return jsonResponse({ error: RATE_LIMIT_RESPONSE.error }, request, RATE_LIMIT_RESPONSE.status);
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await request.json();
  } catch {
    payload = {};
  }

  const action = typeof payload.action === "string" ? payload.action.trim().toLowerCase() : "";

  // Creating and triaging (set_status) are writes on Feature Requests. Voting
  // only needs read: it's part of viewing the board, and the vote rows are keyed
  // to the caller alone.
  // One table binds each mutation to its permission.
  const MUTATIONS: Record<string, { permission: AccessAction; run: () => Promise<Response> }> = {
    create: { permission: "write", run: runCreate },
    vote: { permission: "read", run: runVote },
    unvote: { permission: "read", run: runVote },
    set_status: { permission: "write", run: runSetStatus },
    // Read is only the way in: featureRequestDocumentConfig decides who may
    // change a request's files.
    document_upload_url: {
      permission: "read",
      run: () => handleDocumentUploadUrl(docCtx, docConfig(), request, { ...payload, entityId: payload.featureRequestId }),
    },
    register_document: {
      permission: "read",
      run: () => handleRegisterDocument(docCtx, docConfig(), request, { ...payload, entityId: payload.featureRequestId }),
    },
    delete_document: {
      permission: "read",
      run: () => handleDeleteDocument(docCtx, docConfig(), request, payload),
    },
    update_document: {
      permission: "read",
      run: () => handleUpdateDocument(docCtx, docConfig(), request, payload),
    },
    restore_document: {
      permission: "read",
      run: () => handleRestoreDocument(docCtx, docConfig(), request, payload),
    },
    purge_document: {
      permission: "read",
      run: () => handlePurgeDocument(docCtx, docConfig(), request, payload),
    },
  };
  const docCtx = { serviceClient, callerId };
  const docConfig = () => featureRequestDocumentConfig(serviceClient, callerId, ownOnly);
  const mutation = Object.hasOwn(MUTATIONS, action) ? MUTATIONS[action] : undefined;
  if (!mutation) return jsonResponse({ error: `Unknown action: ${action}` }, request, 400);

  let ownOnly = false;
  {
    const perm = await requirePermission(serviceClient, callerId, "Feature Requests", mutation.permission);
    if (!perm.ok) return jsonResponse({ error: perm.error }, request, perm.status);
    // Creating is always your own, so Own only matters for actions on an existing
    // request: triaging and voting.
    ownOnly = perm.level === LEVEL_OWN;
  }

  /** 403 unless the request in hand was raised by this caller. */
  async function denyIfNotMine(featureRequestId: string): Promise<Response | null> {
    if (!ownOnly) return null;
    const { data, error } = await serviceClient
      .from("feature_requests")
      .select("requested_by")
      .eq("id", featureRequestId)
      .maybeSingle();
    // A failed read isn't "not found"; treating it as one let the handler's query
    // run anyway under Own.
    if (error) return internalError(request, error, "feature request owner");
    if (!data) return null; // let the handler give its own 404
    if (data.requested_by === callerId) return null;
    return jsonResponse({ error: "That feature request is not yours." }, request, 403);
  }

  async function runCreate(): Promise<Response> {
    const raw = typeof payload.description === "string" ? payload.description.trim() : "";
    const area = pickFrom(payload.area, AREAS);
    const featureType = pickFrom(payload.featureType, FEATURE_TYPES);
    // Impact is optional: null when not chosen, else a valid value.
    const impactRaw = typeof payload.impact === "string" ? payload.impact.trim() : "";
    const impact = impactRaw ? pickFrom(payload.impact, IMPACTS) : null;

    if (!raw) {
      return jsonResponse({ error: "A description is required." }, request, 400);
    }
    if (overMaxLength(raw, MAX_TEXT)) {
      return jsonResponse({ error: `Description must be ${MAX_TEXT} characters or fewer.` }, request, 400);
    }
    if (!area || !featureType) {
      return jsonResponse({ error: "area and featureType must be valid values." }, request, 400);
    }
    if (impactRaw && !impact) {
      return jsonResponse({ error: "impact must be a valid value." }, request, 400);
    }

    const title = titleFromDescription(raw).slice(0, MAX_NAME);
    const description = raw;

    const { data: created, error } = await serviceClient
      .from("feature_requests")
      .insert({
        title,
        area,
        feature_type: featureType,
        impact,
        description,
        status: "Open",
        requested_by: callerId,
      })
      .select("id, reference")
      .single();

    if (error) return internalError(request, error, "feature request insert");

    return jsonResponse({
      message: "Feature request logged.",
      // The new request's id, so files picked before submitting can follow it.
      id: typeof created?.id === "string" ? created.id : null,
      reference: typeof created?.reference === "string" ? created.reference : "",
    }, request);
  }

  // Vote / un-vote. The unique (feature_request_id, user_id) constraint makes a
  // duplicate insert fail harmlessly, so voting is idempotent; the trigger keeps
  // vote_count current.
  async function runVote(): Promise<Response> {
    const featureRequestId = typeof payload.featureRequestId === "string" ? payload.featureRequestId.trim() : "";
    if (!isUuid(featureRequestId)) {
      return jsonResponse({ error: "A valid featureRequestId is required." }, request, 400);
    }
    // Voting needs read, so someone who can only see their own requests can only
    // vote on their own. You can't vote on a board you can't see.
    const voteDenied = await denyIfNotMine(featureRequestId);
    if (voteDenied) return voteDenied;

    if (action === "vote") {
      const { error } = await serviceClient
        .from("feature_request_votes")
        .upsert(
          { feature_request_id: featureRequestId, user_id: callerId },
          { onConflict: "feature_request_id,user_id", ignoreDuplicates: true },
        );
      if (error) return internalError(request, error, "feature request vote");
    } else {
      const { error } = await serviceClient
        .from("feature_request_votes")
        .delete()
        .eq("feature_request_id", featureRequestId)
        .eq("user_id", callerId);
      if (error) return internalError(request, error, "feature request unvote");
    }

    // Read the fresh cached tally back so the client doesn't guess.
    const { data: row, error: readError } = await serviceClient
      .from("feature_requests")
      .select("vote_count")
      .eq("id", featureRequestId)
      .single();
    if (readError) return internalError(request, readError, "feature request vote count");

    return jsonResponse({ voteCount: row?.vote_count ?? 0, hasVoted: action === "vote" }, request);
  }

  async function runSetStatus(): Promise<Response> {
    const featureRequestId = typeof payload.featureRequestId === "string" ? payload.featureRequestId.trim() : "";
    if (!isUuid(featureRequestId)) {
      return jsonResponse({ error: "A valid featureRequestId is required." }, request, 400);
    }
    const statusDenied = await denyIfNotMine(featureRequestId);
    if (statusDenied) return statusDenied;
    const status = pickFrom(payload.status, STATUSES);
    if (!featureRequestId || !status) {
      return jsonResponse({ error: "featureRequestId and a valid status are required." }, request, 400);
    }
    const { error } = await serviceClient
      .from("feature_requests")
      .update({ status, updated_at: new Date().toISOString(), updated_by: callerId })
      .eq("id", featureRequestId);
    if (error) return internalError(request, error, "feature request status");
    return jsonResponse({ message: "Status updated." }, request);
  }

  return mutation.run();
  }));
