// A person's working details: phone, country, employing entity,
// approval delegate and signing authority. Only imports import-free modules so
// the tests run this file. The caller checks that the ids it's given exist.
import { isCountryCode, isUuid } from "./validation.ts";

const E164_RE = /^\+[1-9][0-9]{7,14}$/;
export const MAX_SIGNING_LIMIT = 1_000_000_000_000;

export interface PersonDetails {
  phone: string;
  country_code: string;
  employing_entity_id: string | null;
  delegate_id: string | null;
}

/**
 * The details any Users write may change (people can set their own). Only
 * the keys in the payload change. `personId` is who's being changed, so they
 * can't be their own delegate.
 */
export function normalizePersonDetails(
  payload: Record<string, unknown>,
  personId: string | null,
): { value: Partial<PersonDetails> } | { error: string } {
  const text = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string).trim() : "");
  const id = (key: string): string | null | false => {
    const v = payload[key];
    if (v === null || v === "" || v === undefined) return null;
    return isUuid(v) ? v : false;
  };
  const value: Partial<PersonDetails> = {};
  if ("phone" in payload) {
    const phone = text("phone");
    if (phone && !E164_RE.test(phone)) return { error: "The phone number is not a valid international number." };
    value.phone = phone;
  }
  if ("countryCode" in payload) {
    const country = text("countryCode").toUpperCase();
    if (country && !isCountryCode(country)) return { error: "countryCode must be two letters." };
    value.country_code = country;
  }
  if ("employingEntityId" in payload) {
    const entity = id("employingEntityId");
    if (entity === false) return { error: "Invalid employing entity." };
    value.employing_entity_id = entity;
  }
  if ("delegateId" in payload) {
    const delegate = id("delegateId");
    if (delegate === false) return { error: "Invalid delegate." };
    if (delegate && delegate === personId) return { error: "A person cannot be their own delegate." };
    value.delegate_id = delegate;
  }
  return { value };
}

/** Signing authority, for the keys in the payload. Only someone with Users &
 *  Access Roles write sends these. No signing means no limit. */
export function normalizeSigning(
  payload: Record<string, unknown>,
): { value: { can_sign?: boolean; signing_limit?: number | null } } | { error: string } {
  const value: { can_sign?: boolean; signing_limit?: number | null } = {};
  if ("canSign" in payload) value.can_sign = payload.canSign === true;
  if ("signingLimit" in payload) {
    const raw = payload.signingLimit;
    if (raw === null || raw === "" || raw === undefined) value.signing_limit = null;
    else {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n) || n <= 0 || n > MAX_SIGNING_LIMIT) {
        return { error: "The signing limit must be a positive amount, or blank for no limit." };
      }
      value.signing_limit = Math.round(n * 100) / 100;
    }
  }
  if (value.can_sign === false) value.signing_limit = null;
  return { value };
}

/** Whether the payload touches signing authority (which needs the account
 *  grant). */
export function touchesSigning(payload: Record<string, unknown>): boolean {
  return "canSign" in payload || "signingLimit" in payload;
}
