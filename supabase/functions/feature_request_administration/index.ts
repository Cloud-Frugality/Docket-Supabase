import type { ServiceClient } from "../_shared/service-client.ts";
import { internalError, jsonResponse } from "../_shared/http.ts";
import { withAuthorizedCaller } from "../_shared/serve.ts";
import { RATE_LIMIT_RESPONSE, takeRateLimitToken } from "../_shared/rate-limit.ts";
import { MAX_NAME, MAX_TEXT, overMaxLength, pickFrom } from "../_shared/validation.ts";
import {
  BUG_LOCATIONS as AREAS,
  FEATURE_IMPACTS as IMPACTS,
  FEATURE_TYPES,
} from "../_shared/vocabularies.ts";
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
    // The only reads are a request's files.
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
    return jsonResponse({ error: `Unknown action: ${readAction}` }, request, 400);
  }

  // Mutations
  // One rate-limit token per mutating request: 15 burst, one per 2s.
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

  // One table binds each mutation to its permission.
  const MUTATIONS: Record<string, { permission: AccessAction; run: () => Promise<Response> }> = {
    create: { permission: "write", run: runCreate },
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
    ownOnly = perm.level === LEVEL_OWN;
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

  return mutation.run();
  }));
