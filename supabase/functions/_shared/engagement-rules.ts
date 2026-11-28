// Rules for every path that writes an engagement or a client, plus the team
// rules that sit on top of the access roles. Only imports import-free _shared
// modules, so the tests run this file.
import { MAX_NAME, MAX_TEXT, isCountryCode, isDisplayName, isEmail, isIsoDateString, overMaxLength } from "./validation.ts";
import type { CallerTeams } from "./permissions.ts";

// Stored lowercase; the app labels them.
export const ENGAGEMENT_STATUSES = ["prospective", "active", "closed"] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

export const MAX_REFERENCE = 100;
export const MAX_SHORT_NAME = 50;

/** Case-insensitive match to the canonical spelling; null if invalid. */
export function normalizeEngagementStatus(value: unknown): EngagementStatus | null {
  if (typeof value !== "string") return null;
  const needle = value.trim().toLowerCase();
  return ENGAGEMENT_STATUSES.find((status) => status === needle) ?? null;
}

/** null when the input may become an engagement row, else the 400 message.
 *  The type and team are ids, checked against their tables by the caller. */
export function engagementInputError(input: {
  engagementName: string;
  startDate: string;
  endDate: string;
  countryCode: string;
  reference: string;
  description: string;
}): string | null {
  if (!isDisplayName(input.engagementName)) {
    return "engagementName must contain at least one letter or number.";
  }
  if (overMaxLength(input.engagementName, MAX_NAME)) {
    return "engagementName is too long.";
  }
  if (!isCountryCode(input.countryCode)) {
    return "countryCode must be two letters.";
  }
  if (!isIsoDateString(input.startDate) || !isIsoDateString(input.endDate)) {
    return "Dates must be yyyy-MM-dd.";
  }
  if (input.endDate < input.startDate) {
    return "endDate cannot be before startDate.";
  }
  if (overMaxLength(input.reference, MAX_REFERENCE)) {
    return `reference must be ${MAX_REFERENCE} characters or fewer.`;
  }
  if (overMaxLength(input.description, MAX_TEXT)) {
    return `description must be ${MAX_TEXT} characters or fewer.`;
  }
  return null;
}

/** The optional client details, or the 400 message. Registration details live
 *  on the client's legal entities. */
export function clientDetailsError(input: {
  shortName: string;
  primaryContactName: string;
  primaryContactEmail: string;
}): string | null {
  if (overMaxLength(input.shortName, MAX_SHORT_NAME)) return `shortName must be ${MAX_SHORT_NAME} characters or fewer.`;
  if (overMaxLength(input.primaryContactName, MAX_NAME)) return "primaryContactName is too long.";
  if (input.primaryContactEmail && !isEmail(input.primaryContactEmail)) return "primaryContactEmail is not an email address.";
  if (overMaxLength(input.primaryContactEmail, MAX_NAME)) return "primaryContactEmail is too long.";
  return null;
}

// Legal entities
// Who a contract or invoice is with: one of ours or one of a client's. The
// registered name is the legal one; the trading name, when different, is what
// it's known as.

export interface EntityDetails {
  registered_name: string;
  trading_name: string;
  registration_number: string;
  tax_number: string;
  address_line_1: string;
  address_line_2: string;
  city: string;
  province: string;
  postal_code: string;
  country_code: string;
}

/** An address as documents print it: a line each, the province and postal code together. */
export function addressBlock(a: { line1: string; line2: string; city: string; province: string; postalCode: string }): string {
  return [a.line1, a.line2, a.city, [a.province, a.postalCode].filter(Boolean).join(" ")].filter(Boolean).join("\n");
}

/** An entity's details, trimmed, or the 400 message. */
export function normalizeEntity(payload: Record<string, unknown>): { value: EntityDetails } | { error: string } {
  const text = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string).trim() : "");
  const value: EntityDetails = {
    registered_name: text("registeredName"),
    trading_name: text("tradingName"),
    registration_number: text("registrationNumber"),
    tax_number: text("taxNumber"),
    address_line_1: text("addressLine1"),
    address_line_2: text("addressLine2"),
    city: text("city"),
    province: text("province"),
    postal_code: text("postalCode"),
    country_code: text("countryCode").toUpperCase(),
  };
  if (!isDisplayName(value.registered_name)) return { error: "A registered name is required." };
  if (overMaxLength(value.registered_name, MAX_NAME) || overMaxLength(value.trading_name, MAX_NAME)) {
    return { error: "Names must be 200 characters or fewer." };
  }
  if (overMaxLength(value.registration_number, MAX_REFERENCE) || overMaxLength(value.tax_number, MAX_REFERENCE)) {
    return { error: `Registration and tax numbers must be ${MAX_REFERENCE} characters or fewer.` };
  }
  if (overMaxLength(value.address_line_1, MAX_NAME) || overMaxLength(value.address_line_2, MAX_NAME)) {
    return { error: "Address lines must be 200 characters or fewer." };
  }
  if (overMaxLength(value.city, MAX_REFERENCE) || overMaxLength(value.province, MAX_REFERENCE)) {
    return { error: `The city and province must be ${MAX_REFERENCE} characters or fewer.` };
  }
  if (overMaxLength(value.postal_code, 20)) return { error: "The postal code must be 20 characters or fewer." };
  if (value.country_code && !isCountryCode(value.country_code)) return { error: "countryCode must be two letters." };
  // A trading name the same as the registered one says nothing.
  if (value.trading_name.toLowerCase() === value.registered_name.toLowerCase()) value.trading_name = "";
  return { value };
}

/** Switching an entity off: never its side's default, which documents fall
 *  back to. */
export function entityDeactivateError(isDefault: boolean, willBeActive: boolean): string | null {
  return isDefault && !willBeActive ? "Make another entity the default before switching this one off." : null;
}

/** Why an entity can't be deleted, or null. Only one nothing names can go:
 *  the rest are switched off instead, so what points at them keeps its entity. */
export function entityDeleteError(isDefault: boolean, uses: { engagements: number; teams: number; people: number }): string | null {
  if (isDefault) return "Make another entity the default before deleting this one.";
  const named = [
    uses.engagements > 0 ? "engagements" : "",
    uses.teams > 0 ? "teams" : "",
    uses.people > 0 ? "people" : "",
  ].filter(Boolean);
  return named.length > 0 ? `This entity is in use by ${named.join(" and ")}. Switch it off instead.` : null;
}

// Team rules, checked after the access role has said yes

export type { CallerTeams };

/** A client is made in a team, by a member of it (or a global admin). Who
 *  may change one afterwards is the visibility rule's Can edit. */
export function clientCreateError(caller: CallerTeams, teamId: string): string | null {
  return caller.globalAdmin || caller.teamIds.includes(teamId)
    ? null
    : "Only members of a team can add clients to it.";
}

/** Deleting a client outright is for global admins; anyone else archives. */
export function clientDeleteError(caller: CallerTeams): string | null {
  return caller.globalAdmin ? null : "Only a global admin can delete a client. Archive it instead.";
}

/** Archiving (the app's delete) is for the owning team's admins. */
export function engagementArchiveError(caller: CallerTeams, teamId: string): string | null {
  return caller.globalAdmin || caller.adminTeamIds.includes(teamId)
    ? null
    : "Only a team admin of the owning team can delete this engagement.";
}

/** The plain message for a name already used under the same parent, or null
 *  when the error is something else. */
export function duplicateNameError(error: unknown): string | null {
  const e = (error ?? {}) as { code?: unknown; message?: unknown; details?: unknown };
  if (e.code !== "23505") return null;
  const text = `${String(e.message ?? "")} ${String(e.details ?? "")}`;
  if (text.includes("clients_team_name")) return "A client of that name is already in this team.";
  if (text.includes("engagements_client_name")) return "An engagement of that name is already under this client.";
  return null;
}
