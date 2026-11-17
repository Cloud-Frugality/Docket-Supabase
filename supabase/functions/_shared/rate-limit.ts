// Per-user token bucket for the expensive endpoints. State lives in
// public.rate_limit_buckets and the take is one atomic RPC, so concurrent
// isolates can't double-spend. Import-free so the tests run this file.

import type { ServiceClient } from "./service-client.ts";

/** True when the caller may proceed; false means serve a 429. Fails open on
 *  an RPC error: for an internal tool, availability beats a throttle, and the
 *  error is logged. */
export async function takeRateLimitToken(
  serviceClient: Pick<ServiceClient, "rpc">,
  key: string,
  capacity: number,
  refillPerSec: number,
): Promise<boolean> {
  const { data, error } = await serviceClient.rpc("rate_limit_take", {
    p_key: key,
    p_capacity: capacity,
    p_refill_per_sec: refillPerSec,
  });
  if (error) {
    console.error("rate_limit_take failed:", error.message ?? error);
    return true;
  }
  return data === true;
}

/** The standard refusal payload for a rate-limited caller. */
export const RATE_LIMIT_RESPONSE = {
  status: 429,
  error: "Too many requests. Give it a moment and try again.",
} as const;
