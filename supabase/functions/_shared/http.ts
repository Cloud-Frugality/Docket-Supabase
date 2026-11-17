import { getCorsHeaders } from "./cors.ts";

/** A JSON response with the CORS and cache headers. */
export function jsonResponse(body: unknown, request: Request, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(request),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Logs the real error server-side and returns a generic 500, so Postgres error
 * text (table, column and constraint names, conflicting values) never reaches
 * the browser. Use for unexpected failures; keep explicit 400s for input
 * validation.
 */
export function internalError(request: Request, err: unknown, context = ""): Response {
  const detail = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  console.error(context ? `${context}: ${detail}` : detail);
  return jsonResponse({ error: "An unexpected error occurred. Please try again." }, request, 500);
}
