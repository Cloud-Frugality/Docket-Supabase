import { getCorsHeaders } from "./cors.ts";
import { getEnvVars } from "./env.ts";
import { assertAuthorizedCaller } from "./jwt.ts";
import { internalError, jsonResponse } from "./http.ts";
import type { ServiceClient } from "./service-client.ts";

export interface AuthorizedContext {
  request: Request;
  serviceClient: ServiceClient;
  authClient: ServiceClient;
  callerId: string;
}

/**
 * The preamble every business function shares: CORS preflight, env, then JWT
 * and AAL2 checks via assertAuthorizedCaller. The handler only runs once all
 * of that passes.
 */
export async function withAuthorizedCaller(
  request: Request,
  handler: (ctx: AuthorizedContext) => Promise<Response>,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: getCorsHeaders(request) });
  }

  const env = getEnvVars();
  if ("error" in env) {
    return jsonResponse({ error: env.error }, request, env.status);
  }

  const auth = await assertAuthorizedCaller(request, env.publishableKey, env.secretKey, env.supabaseUrl);
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, request, auth.status);
  }

  // Catch a handler that throws, or Deno returns a bare 500 without CORS headers
  // and the browser reports it as a cross-origin failure. This way every failure
  // has CORS, the usual JSON shape and a log line with the real cause.
  try {
    return await handler({
      request,
      serviceClient: auth.serviceClient as ServiceClient,
      authClient: auth.authClient as ServiceClient,
      callerId: auth.callerId,
    });
  } catch (err) {
    return internalError(request, err, "unhandled");
  }
}
