import { createClient } from "https://esm.sh/@supabase/supabase-js@2.111.0";
import { getEnvVars } from "../_shared/env.ts";
import { appToday } from "../_shared/app-date.ts";
import { loadOrgLocale } from "../_shared/organisation-locale.ts";
import { sweepBin } from "../_shared/bin-sweep.ts";
import { cronAuthorized } from "../_shared/cron-auth.ts";
import type { ServiceClient } from "../_shared/service-client.ts";

// The most passes in one run, so a very full bin is worked off over a few
// nights rather than holding one request open.
const MAX_PASSES = 20;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * The nightly recycle bin clean-up, called by the database's scheduler and by
 * nobody else. There is no signed-in caller, so it is let in by a shared
 * secret (CRON_SECRET) instead of a user's token, and deployed without the
 * gateway's JWT check for the same reason. It takes no input.
 */
Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!cronAuthorized(request.headers.get("x-cron-secret"), Deno.env.get("CRON_SECRET"))) {
    return json({ error: "Not authorised." }, 401);
  }
  const env = getEnvVars();
  if ("error" in env) return json({ error: env.error }, env.status);

  const serviceClient = createClient(env.supabaseUrl, env.secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  }) as ServiceClient;
  const today = appToday(new Date(), (await loadOrgLocale(serviceClient)).timeZone);
  let deleted = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const count = await sweepBin(serviceClient, today);
    if (count === 0) break;
    deleted += count;
  }
  console.log("recycle bin sweep deleted", deleted);
  return json({ deleted });
});
