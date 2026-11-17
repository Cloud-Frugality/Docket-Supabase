// Reads the MFA level (aal) claim from a JWT. Only call this on a token that's
// already been validated (assertAuthorizedCaller calls getUser first); it just
// decodes the payload. Import-free so the tests run this exact file.

/** The `aal` claim from a JWT's payload, or "aal1" if absent/unreadable. */
export function readAal(token: string): string {
  try {
    const payload = token.split(".")[1];
    if (!payload) return "aal1";
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { aal?: unknown };
    return typeof claims.aal === "string" ? claims.aal : "aal1";
  } catch {
    // Fail closed: an unreadable token counts as the lowest level, so it's
    // rejected rather than waved through.
    return "aal1";
  }
}

/** True when the token has completed MFA (reached AAL2). */
export function isAal2(token: string): boolean {
  return readAal(token) === "aal2";
}
