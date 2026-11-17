import { withAuthorizedCaller } from "../_shared/serve.ts";
import type { ServiceClient } from "../_shared/service-client.ts";
import { internalError, jsonResponse } from "../_shared/http.ts";
import { requirePermission } from "../_shared/permissions.ts";
import { RATE_LIMIT_RESPONSE, takeRateLimitToken } from "../_shared/rate-limit.ts";
import { DASHBOARD_LAYOUT_PREFIXES, SYNCED_PREFERENCE_PREFIXES } from "../_shared/vocabularies.ts";

/**
 * View preferences that follow the user. The browser keeps its copy in
 * localStorage (through prefStorage) and this is the store behind it: one read
 * after sign-in, then each change written back. Callers only touch their own
 * rows, so no RBAC grant is involved, except publishing the default layouts,
 * which needs Users & Access Roles write. Values are opaque here; the server
 * only checks the key may sync and the value is a sane size.
 */

const MAX_KEY = 200;
const MAX_VALUE = 50_000;
// A person has a dozen keys; this cap stops a login with no role filling the
// table a key at a time.
const MAX_KEYS_PER_USER = 100;
const DEFAULTS_ENTITY = "Users & Access Roles";

const synced = (key: string) => SYNCED_PREFERENCE_PREFIXES.some((p) => key.startsWith(p));
const layoutKey = (key: string) => DASHBOARD_LAYOUT_PREFIXES.some((p) => key.startsWith(p));

function keyError(key: unknown, allowed: (key: string) => boolean): string | null {
  if (typeof key !== "string" || !key || key.length > MAX_KEY) return "A valid preference key is required.";
  if (!allowed(key)) return `"${key}" is not a preference that can be saved to your account.`;
  return null;
}

function valueError(value: unknown): string | null {
  if (typeof value !== "string") return "A preference value must be a string.";
  if (value.length > MAX_VALUE) return `A preference value must be ${MAX_VALUE} characters or fewer.`;
  return null;
}

type Handler = (serviceClient: ServiceClient, callerId: string, request: Request, payload: Record<string, unknown>) => Promise<Response>;

async function handleSet(serviceClient: ServiceClient, callerId: string, request: Request, payload: Record<string, unknown>) {
  const problem = keyError(payload.key, synced) ?? valueError(payload.value);
  if (problem) return jsonResponse({ error: problem }, request, 400);
  const { count, error: countError } = await serviceClient
    .from("user_preferences")
    .select("key", { count: "exact", head: true })
    .eq("user_id", callerId)
    .neq("key", payload.key);
  if (countError) return internalError(request, countError, "preference count");
  if ((count ?? 0) >= MAX_KEYS_PER_USER) {
    return jsonResponse({ error: "Too many saved preferences on this account." }, request, 400);
  }
  const { error } = await serviceClient
    .from("user_preferences")
    .upsert(
      { user_id: callerId, key: payload.key, value: payload.value, updated_at: new Date().toISOString() },
      { onConflict: "user_id,key" },
    );
  if (error) return internalError(request, error, "preference save");
  return jsonResponse({ key: payload.key }, request);
}

async function handleRemove(serviceClient: ServiceClient, callerId: string, request: Request, payload: Record<string, unknown>) {
  const problem = keyError(payload.key, synced);
  if (problem) return jsonResponse({ error: problem }, request, 400);
  const { error } = await serviceClient.from("user_preferences").delete().eq("user_id", callerId).eq("key", payload.key);
  if (error) return internalError(request, error, "preference remove");
  return jsonResponse({ key: payload.key }, request);
}

/** Delete every preference the caller has saved: what turning off the privacy
 *  panel's Preferences switch does to the server copy. */
async function handleClear(serviceClient: ServiceClient, callerId: string, request: Request) {
  const { error } = await serviceClient.from("user_preferences").delete().eq("user_id", callerId);
  if (error) return internalError(request, error, "preference clear");
  return jsonResponse({ cleared: true }, request);
}

/** Publish dashboard layouts as everyone's starting point. Replaces the
 *  defaults for the keys sent; a person's own layout still wins over them. */
async function handleSetDefaults(serviceClient: ServiceClient, callerId: string, request: Request, payload: Record<string, unknown>) {
  const perm = await requirePermission(serviceClient, callerId, DEFAULTS_ENTITY, "write");
  if (!perm.ok) return jsonResponse({ error: perm.error }, request, perm.status);
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  if (entries.length === 0 || entries.length > DASHBOARD_LAYOUT_PREFIXES.length * 4) {
    return jsonResponse({ error: "Send the layouts to publish." }, request, 400);
  }
  const rows: Array<{ key: string; value: string; updated_by: string; updated_at: string }> = [];
  for (const entry of entries as Array<Record<string, unknown>>) {
    const problem = keyError(entry?.key, layoutKey) ?? valueError(entry?.value);
    if (problem) return jsonResponse({ error: problem }, request, 400);
    rows.push({ key: String(entry.key), value: String(entry.value), updated_by: callerId, updated_at: new Date().toISOString() });
  }
  const { error } = await serviceClient.from("preference_defaults").upsert(rows, { onConflict: "key" });
  if (error) return internalError(request, error, "preference defaults save");
  return jsonResponse({ published: rows.length }, request);
}

const MUTATIONS: Record<string, Handler> = {
  set: handleSet,
  remove: handleRemove,
  clear: (serviceClient, callerId, request) => handleClear(serviceClient, callerId, request),
  set_defaults: handleSetDefaults,
};

Deno.serve((request) =>
  withAuthorizedCaller(request, async ({ request, serviceClient, callerId }) => {
    if (request.method === "GET") {
      const action = new URL(request.url).searchParams.get("action") ?? "";
      if (action !== "list") return jsonResponse({ error: `Unknown action: ${action}` }, request, 400);
      const [mine, defaults] = await Promise.all([
        serviceClient.from("user_preferences").select("key, value").eq("user_id", callerId),
        serviceClient.from("preference_defaults").select("key, value"),
      ]);
      if (mine.error) return internalError(request, mine.error, "preference list");
      if (defaults.error) return internalError(request, defaults.error, "preference defaults list");
      const toMap = (rows: unknown) =>
        Object.fromEntries(
          ((rows ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.key), String(r.value)]),
        );
      return jsonResponse({ preferences: toMap(mine.data), defaults: toMap(defaults.data) }, request);
    }

    // Layout drags and fold toggles come in bursts, and the browser already waits
    // a second before writing each key: 20 in a burst, then one every ten seconds,
    // which real use never hits.
    const allowed = await takeRateLimitToken(serviceClient, `preferences:${callerId}`, 20, 0.1);
    if (!allowed) return jsonResponse({ error: RATE_LIMIT_RESPONSE.error }, request, RATE_LIMIT_RESPONSE.status);

    let payload: Record<string, unknown> = {};
    try {
      payload = await request.json();
    } catch {
      payload = {};
    }
    const action = typeof payload.action === "string" ? payload.action : "";
    const run = MUTATIONS[action];
    if (!run) return jsonResponse({ error: `Unknown action: ${action}` }, request, 400);
    return run(serviceClient, callerId, request, payload);
  }));
