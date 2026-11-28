import { internalError, jsonResponse } from "../_shared/http.ts";
import { withAuthorizedCaller } from "../_shared/serve.ts";
import { RATE_LIMIT_RESPONSE, takeRateLimitToken } from "../_shared/rate-limit.ts";
import { MAX_NAME, MAX_TEXT, overMaxLength, pickFrom } from "../_shared/validation.ts";
import {
  BROWSERS,
  BUG_LOCATIONS as LOCATIONS,
  BUG_SEVERITIES as SEVERITIES,
  BUG_STATUSES as STATUSES,
  DEFECT_TYPES,
} from "../_shared/vocabularies.ts";
import { requirePermission } from "../_shared/permissions.ts";
import type { ServiceClient } from "../_shared/service-client.ts";

// Fixed vocabularies live in _shared/vocabularies.ts, kept in step with
// the Windows app.

const SCREENSHOT_BUCKET = "bug-screenshots";
// Decoded bytes. Screenshots are usually well under this; it stops a huge
// paste blowing the function's request budget.
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

function extensionFor(contentType: string): string {
  switch (contentType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    default: return "bin";
  }
}

async function handleCreate(
  serviceClient: ServiceClient,
  callerId: string,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const description = typeof payload.description === "string" ? payload.description.trim() : "";
  const stepsToReproduce = typeof payload.stepsToReproduce === "string" ? payload.stepsToReproduce.trim() : "";

  const location = pickFrom(payload.location, LOCATIONS);
  const defectType = pickFrom(payload.defectType, DEFECT_TYPES);
  const severity = pickFrom(payload.severity, SEVERITIES);
  const browser = pickFrom(payload.browser, BROWSERS);
  const status = pickFrom(payload.status, STATUSES) ?? "Open";

  if (!title || !description) {
    return jsonResponse({ error: "title and description are required." }, request, 400);
  }
  if (overMaxLength(title, MAX_NAME)) {
    return jsonResponse({ error: `title must be ${MAX_NAME} characters or fewer.` }, request, 400);
  }
  if (overMaxLength(description, MAX_TEXT) || overMaxLength(stepsToReproduce, MAX_TEXT)) {
    return jsonResponse({ error: `description and steps must be ${MAX_TEXT} characters or fewer.` }, request, 400);
  }
  if (!location || !defectType || !severity || !browser) {
    return jsonResponse({ error: "location, defectType, severity and browser must be valid values." }, request, 400);
  }

  // The screenshot is optional. It arrives base64 so the browser never needs
  // write access to storage; this function uploads it with the service role.
  let screenshotPath: string | null = null;
  const screenshot = typeof payload.screenshot === "object" && payload.screenshot !== null
    ? payload.screenshot as Record<string, unknown>
    : null;

  if (screenshot) {
    const contentType = typeof screenshot.contentType === "string" ? screenshot.contentType.trim() : "";
    const dataBase64 = typeof screenshot.dataBase64 === "string" ? screenshot.dataBase64 : "";

    if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(contentType)) {
      return jsonResponse({ error: "Screenshot must be a PNG, JPEG, GIF or WebP image." }, request, 400);
    }

    let bytes: Uint8Array;
    try {
      const binary = atob(dataBase64);
      bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch {
      return jsonResponse({ error: "Screenshot could not be decoded." }, request, 400);
    }

    if (bytes.byteLength === 0) {
      return jsonResponse({ error: "Screenshot is empty." }, request, 400);
    }
    if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
      return jsonResponse({ error: "Screenshot must be 4MB or smaller." }, request, 400);
    }

    // Never trust the client's filename for the object path.
    const path = `${crypto.randomUUID()}.${extensionFor(contentType)}`;
    const { error: uploadError } = await serviceClient
      .storage
      .from(SCREENSHOT_BUCKET)
      .upload(path, bytes, { contentType, upsert: false });

    if (uploadError) {
      return internalError(request, uploadError, "bug screenshot upload");
    }
    screenshotPath = path;
  }

  const { data: created, error } = await serviceClient
    .from("bug_reports")
    .insert({
      title,
      location,
      defect_type: defectType,
      severity,
      browser,
      status,
      description,
      steps_to_reproduce: stepsToReproduce || null,
      screenshot_path: screenshotPath,
      route: typeof payload.route === "string" ? payload.route.slice(0, MAX_NAME) : null,
      user_agent: typeof payload.userAgent === "string" ? payload.userAgent.slice(0, MAX_TEXT) : null,
      viewport: typeof payload.viewport === "string" ? payload.viewport.slice(0, 32) : null,
      created_by: callerId,
    })
    .select("reference")
    .single();

  if (error) {
    return internalError(request, error, "bug report insert");
  }

  return jsonResponse({
    message: "Bug report logged.",
    reference: typeof created?.reference === "string" ? created.reference : "",
  }, request);
}

// One table binds each mutation to its permission.
// Filing a defect is a write on Bug Reports.
const MUTATION_ENTITY = "Bug Reports";
/** Where a crash happened, in the defect board's own area vocabulary. */
function locationForRoute(route: string): (typeof LOCATIONS)[number] {
  if (route.startsWith("/clients")) return "Client Management";
  if (route.startsWith("/engagements")) return "Engagement Management";
  if (route.startsWith("/documents")) return "Documents";
  if (route.startsWith("/users")) return "Users";
  if (route.startsWith("/sign-in")) return "Sign In";
  return "Other";
}

/**
 * A page crash reported by the browser's error boundary. It's filed as a
 * normal defect (Functionality, High, Open) with the message as title and the
 * stack in the body, so someone actually sees it. Any signed-in caller may
 * send one, since crashing needs no permission; the rate limit bounds a page
 * that crashes in a loop.
 */
async function handleRecordCrash(
  serviceClient: ServiceClient,
  callerId: string,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!message) return jsonResponse({ error: "message is required." }, request, 400);
  const route = typeof payload.route === "string" ? payload.route.slice(0, MAX_NAME) : "";
  const stack = typeof payload.stack === "string" ? payload.stack : "";
  const componentStack = typeof payload.componentStack === "string" ? payload.componentStack : "";

  const title = `Crash: ${message}`.slice(0, MAX_NAME);
  const description = `${message}\n\nPage: ${route || "unknown"}\n\n${stack}`.slice(0, MAX_TEXT);
  const { data: created, error } = await serviceClient
    .from("bug_reports")
    .insert({
      title,
      location: locationForRoute(route),
      defect_type: "Functionality",
      severity: "High",
      browser: pickFrom(payload.browser, BROWSERS) ?? "Other",
      status: "Open",
      description,
      steps_to_reproduce: componentStack ? `Component stack:${componentStack}`.slice(0, MAX_TEXT) : null,
      route: route || null,
      user_agent: typeof payload.userAgent === "string" ? payload.userAgent.slice(0, MAX_TEXT) : null,
      viewport: typeof payload.viewport === "string" ? payload.viewport.slice(0, 32) : null,
      created_by: callerId,
    })
    .select("reference")
    .single();
  if (error) return internalError(request, error, "crash report insert");
  return jsonResponse({
    message: "Crash reported.",
    reference: typeof created?.reference === "string" ? created.reference : "",
  }, request);
}

const MUTATIONS: Record<string, {
  /** null: any signed-in caller (a crash report needs no grant). */
  permission: "write" | "delete" | null;
  run: (serviceClient: ServiceClient, callerId: string, request: Request, payload: Record<string, unknown>) => Promise<Response>;
}> = {
  create: { permission: "write", run: handleCreate },
  record_crash: { permission: null, run: handleRecordCrash },
};

Deno.serve((request) =>
  withAuthorizedCaller(request, async ({ request, serviceClient, callerId }) => {

  // A bug report carries a screenshot, so its writes are the most expensive to
  // accept: 5 burst, then one every 6s.
  if (request.method !== "GET") {
    const allowed = await takeRateLimitToken(serviceClient, `bug:${callerId}`, 5, 1 / 6);
    if (!allowed) return jsonResponse({ error: RATE_LIMIT_RESPONSE.error }, request, RATE_LIMIT_RESPONSE.status);
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await request.json();
  } catch {
    payload = {};
  }

  const action = typeof payload.action === "string" ? payload.action.trim().toLowerCase() : "";

  // Nothing is served on GET.
  if (request.method === "GET") return jsonResponse({ error: "Method not allowed." }, request, 405);

  const mutation = MUTATIONS[action];
  if (!mutation) return jsonResponse({ error: `Unknown action: ${action}` }, request, 400);
  if (mutation.permission) {
    const perm = await requirePermission(serviceClient, callerId, MUTATION_ENTITY, mutation.permission);
    if (!perm.ok) return jsonResponse({ error: perm.error }, request, perm.status);
  }

  return mutation.run(serviceClient, callerId, request, payload);
  }));
