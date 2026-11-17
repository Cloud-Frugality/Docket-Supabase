import { createClient } from "https://esm.sh/@supabase/supabase-js@2.111.0";
import { isAal2 } from "./aal.ts";
import type { ServiceClient } from "./service-client.ts";

export interface AuthResult {
  ok: true;
  authClient: ReturnType<typeof createClient>;
  serviceClient: ReturnType<typeof createClient>;
  callerId: string;
}

export interface AuthError {
  ok: false;
  status: number;
  error: string;
}

function getBearerToken(request: Request): string {
  const authorizationHeader = request.headers.get("authorization") ?? "";
  const [scheme, token] = authorizationHeader.split(" ", 2);
  return scheme?.toLowerCase() === "bearer" && token ? token.trim() : "";
}

/**
 * Validates the caller's JWT and returns two clients:
 *
 * - `authClient`: publishable key plus the caller's token, so RLS applies. Use
 *   it for normal reads and writes.
 * - `serviceClient`: the secret key, bypassing RLS. Only for admin calls RLS
 *   can't support (auth.admin.getUserById, auth.admin.listUsers).
 */
export async function assertAuthorizedCaller(
  request: Request,
  publishableKey: string,
  secretKey: string,
  supabaseUrl: string,
): Promise<AuthResult | AuthError> {
  const accessToken = getBearerToken(request);
  if (!accessToken) {
    return { ok: false as const, status: 401, error: "Unauthorized." };
  }

  // Validate the JWT through the auth client.
  const authClient = createClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });

  // Checked locally against the project's signing key: the tokens are ES256, so
  // getClaims checks signature and expiry without a call to the auth server. A
  // login disabled after its token was issued is still refused by
  // caller_permission_levels, which every gated action checks. getUser is the
  // fallback for symmetric-key projects.
  const callerId = await verifiedCallerId(authClient, accessToken);
  if (!callerId) {
    return { ok: false as const, status: 401, error: "Unauthorized." };
  }

  // MFA is mandatory, so the token must be at AAL2. This backs up the UI's
  // MfaGate. Enrolling and challenging go through GoTrue, not these functions,
  // so nothing is locked out.
  if (!isAal2(accessToken)) {
    return { ok: false as const, status: 403, error: "Multi-factor authentication is required." };
  }

  const serviceClient = createClient(supabaseUrl, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return {
    ok: true as const,
    authClient,
    serviceClient,
    callerId,
  };
}

async function verifiedCallerId(
  authClient: Pick<ServiceClient, "auth">,
  accessToken: string,
): Promise<string | null> {
  if (typeof authClient.auth.getClaims === "function") {
    try {
      const { data, error } = await authClient.auth.getClaims(accessToken);
      const sub = data?.claims?.sub;
      if (!error && typeof sub === "string" && sub) return sub;
      if (error) return null;
    } catch {
      // Fall through to the network check rather than refusing a good token.
    }
  }
  const { data: authData, error: authError } = await authClient.auth.getUser(accessToken);
  return !authError && authData.user?.id ? authData.user.id : null;
}