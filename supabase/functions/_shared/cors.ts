// Origins allowed to call the functions, from the ALLOWED_ORIGINS secret (comma
// separated) so adding one is a settings change, not a redeploy. Falls back to
// localhost for dev. Any other origin gets the first entry back, so the browser
// blocks it. Never a wildcard.
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "http://localhost:54321,http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

export function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  };
}
