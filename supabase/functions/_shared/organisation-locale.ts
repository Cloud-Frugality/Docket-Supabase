// The organisation's default country and currency, their locks, and its time
// zone. Unlocked,
// a default only starts a field; locked, it's the only value a function saves,
// whatever it's sent. Pure, so the tests run this file.
import type { ServiceClient } from "./service-client.ts";

export interface OrgLocale {
  defaultCountryCode: string;
  lockCountry: boolean;
  defaultCurrency: string;
  lockCurrency: boolean;
  /** Decides what "today" is. */
  timeZone: string;
  /** How documents print dates. */
  dateFormat: string;
  /** Off: the organisation has no clients, so nothing may name one. */
  clientsEnabled: boolean;
  /** Off: the same for engagements. Never on without clients. */
  engagementsEnabled: boolean;
}

/** What the organisation is before anyone sets anything. */
export const FALLBACK_LOCALE: OrgLocale = {
  defaultCountryCode: "ZA",
  lockCountry: false,
  defaultCurrency: "ZAR",
  lockCurrency: false,
  timeZone: "Africa/Johannesburg",
  dateFormat: "dd MMM yyyy",
  clientsEnabled: true,
  engagementsEnabled: true,
};

/** Why a record can't name a client or an engagement, or null when it can. */
export function switchedOffError(
  locale: Pick<OrgLocale, "clientsEnabled" | "engagementsEnabled">,
  names: { client: boolean; engagement: boolean },
): string | null {
  if (names.client && !locale.clientsEnabled) return "Clients are switched off for this organisation.";
  if (names.engagement && !locale.engagementsEnabled) return "Engagements are switched off for this organisation.";
  return null;
}

/** The country to save: the default when locked, else what was asked for. */
export function effectiveCountry(requested: string, locale: OrgLocale): string {
  return locale.lockCountry ? locale.defaultCountryCode : requested;
}

/**
 * A currency to save. Locked, the default; unlocked, what was asked for, or
 * the default when nothing was. `blankMeansDefault` is for a team's currency,
 * where '' already says "the organisation's", so locked it stays ''.
 */
export function effectiveCurrency(requested: string, locale: OrgLocale, blankMeansDefault = false): string {
  if (locale.lockCurrency) return blankMeansDefault ? "" : locale.defaultCurrency;
  if (!requested) return blankMeansDefault ? "" : locale.defaultCurrency;
  return requested;
}

/** The organisation's settings; the fallback if they can't be read. */
export async function loadOrgLocale(serviceClient: Pick<ServiceClient, "from">): Promise<OrgLocale> {
  const { data, error } = await serviceClient
    .from("organisations")
    .select("default_country_code, lock_country, default_currency, lock_currency, time_zone, date_format, clients_enabled, engagements_enabled")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    if (error) console.error("loadOrgLocale:", error.message);
    return FALLBACK_LOCALE;
  }
  return {
    defaultCountryCode: String(data.default_country_code ?? "ZA"),
    lockCountry: data.lock_country === true,
    defaultCurrency: String(data.default_currency ?? "ZAR"),
    lockCurrency: data.lock_currency === true,
    timeZone: String(data.time_zone ?? FALLBACK_LOCALE.timeZone),
    dateFormat: String(data.date_format ?? FALLBACK_LOCALE.dateFormat),
    clientsEnabled: data.clients_enabled !== false,
    engagementsEnabled: data.engagements_enabled !== false,
  };
}
