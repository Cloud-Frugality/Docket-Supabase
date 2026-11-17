// Who may run a team, and what its membership may look like. Pure, so the
// tests run this file.
//
// A global admin is anyone with Users & Access Roles write; team admin is per
// team, on the membership row. Access roles decide what a person may do; teams
// decide which team-owned records they see.

import { CURRENCIES, REGIONS, TEAM_ROLES } from "./vocabularies.ts";
import { isEmail, isUuid } from "./validation.ts";

export type TeamRole = (typeof TEAM_ROLES)[number];

export const MAX_TEAM_NAME = 200;
export const MAX_TEAM_DESCRIPTION = 1000;
export const MAX_BUSINESS_UNIT = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MemberRow {
  user_id: string;
  role: TeamRole;
}

/** Whether the caller may change a team's membership: a global admin, or an
 *  admin of that team. */
export function canManageMembers(isGlobalAdmin: boolean, callerTeamRole: TeamRole | null): boolean {
  return isGlobalAdmin || callerTeamRole === "team_admin";
}

/**
 * A membership payload ([{ personId, role }]) as clean rows, or why it's
 * refused. A repeated person is refused rather than merged, because two rows
 * for one person means the form disagrees with itself.
 */
export function normalizeMembers(raw: unknown): { rows: MemberRow[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "Members must be a list." };
  const rows: MemberRow[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const personId = (item as { personId?: unknown })?.personId;
    const role = (item as { role?: unknown })?.role;
    if (typeof personId !== "string" || !UUID_RE.test(personId)) {
      return { error: "Every member needs a valid person id." };
    }
    if (typeof role !== "string" || !(TEAM_ROLES as readonly string[]).includes(role)) {
      return { error: `A team role must be one of: ${TEAM_ROLES.join(", ")}.` };
    }
    if (seen.has(personId)) return { error: "A person is listed twice." };
    seen.add(personId);
    rows.push({ user_id: personId, role: role as TeamRole });
  }
  return { rows };
}

/** A list of team ids, deduplicated, or why it's refused. Absent is empty. */
export function normalizeTeamIds(raw: unknown): { ids: string[] } | { error: string } {
  if (raw === undefined) return { ids: [] };
  if (!Array.isArray(raw)) return { error: "Teams must be a list." };
  if (raw.some((id) => typeof id !== "string" || !UUID_RE.test(id))) return { error: "Every team needs a valid id." };
  const ids = [...new Set(raw as string[])];
  if (ids.length > 100) return { error: "That is too many teams at once." };
  return { ids };
}

/**
 * Why adding one person to some teams and taking them out of others is
 * refused, or null. The caller must run every team involved, and a team admin
 * who isn't a global admin can't take themselves out.
 */
export function personTeamsError(change: {
  callerId: string;
  personId: string;
  globalAdmin: boolean;
  /** The teams the caller is a team admin of. */
  adminOf: ReadonlySet<string>;
  add: readonly string[];
  remove: readonly string[];
}): string | null {
  const { callerId, personId, globalAdmin, adminOf, add, remove } = change;
  if (add.length === 0 && remove.length === 0) return "There is nothing to change.";
  if (add.some((id) => remove.includes(id))) return "A team cannot be added and removed at once.";
  if ([...add, ...remove].some((id) => !canManageMembers(globalAdmin, adminOf.has(id) ? "team_admin" : null))) {
    return "You can only change teams you run.";
  }
  if (!globalAdmin && personId === callerId && remove.length > 0) {
    return "You cannot remove yourself from a team you run. Ask another team admin or a global admin to do it.";
  }
  return null;
}

/**
 * A team admin who isn't a global admin can't remove or demote themselves:
 * the save would take away the right they're using and could leave the team
 * with nobody to run it. A global admin can always put it back.
 */
export function selfLockoutError(callerId: string, isGlobalAdmin: boolean, rows: MemberRow[]): string | null {
  if (isGlobalAdmin) return null;
  const own = rows.find((r) => r.user_id === callerId);
  return own?.role === "team_admin"
    ? null
    : "You cannot remove yourself as a team admin. Ask another team admin or a global admin to do it.";
}

/** A name and description, trimmed, or why they're refused. `noun` names the
 *  thing in the message: teams and the other named lists (engagement types,
 *  templates, categories) share the same caps. */
export function cleanTeamDetails(
  name: unknown,
  description: unknown,
  noun = "team",
): { name: string; description: string } | { error: string } {
  const n = typeof name === "string" ? name.trim() : "";
  const d = typeof description === "string" ? description.trim() : "";
  const Noun = noun[0].toUpperCase() + noun.slice(1);
  if (!n) return { error: `A ${noun} name is required.` };
  if (n.length > MAX_TEAM_NAME) return { error: `${Noun} name must be ${MAX_TEAM_NAME} characters or fewer.` };
  if (d.length > MAX_TEAM_DESCRIPTION) {
    return { error: `Description must be ${MAX_TEAM_DESCRIPTION} characters or fewer.` };
  }
  return { name: n, description: d };
}

// A team's profile and settings

export interface TeamProfile {
  /** One of the organisation's business units; null for none. */
  business_unit_id: string | null;
  region: string;
  /** Numbers the team's documents; null for none. */
  reference_prefix: string | null;
  reference_pattern: string;
  /** '' means the organisation's currency (ZAR). */
  default_currency: string;
}

const PREFIX_RE = /^[A-Z0-9]{2,6}$/;

/**
 * The global admin's half of a team (business unit, region, reference
 * prefix, currency), checked; the caller checks the unit exists. Only the keys in the payload come
 * back, so a partial update leaves the rest alone.
 */
export function normalizeTeamProfile(payload: Record<string, unknown>): { value: Partial<TeamProfile> } | { error: string } {
  const text = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string).trim() : "");
  const value: Partial<TeamProfile> = {};
  if ("businessUnitId" in payload) {
    const unit = text("businessUnitId");
    if (unit && !isUuid(unit)) return { error: "Invalid business unit." };
    value.business_unit_id = unit || null;
  }
  if ("region" in payload) {
    const region = text("region");
    if (region && !(REGIONS as readonly string[]).includes(region)) return { error: `Region must be one of: ${REGIONS.join(", ")}.` };
    value.region = region;
  }
  if ("referencePrefix" in payload) {
    const prefix = text("referencePrefix").toUpperCase();
    if (prefix && !PREFIX_RE.test(prefix)) return { error: "A reference prefix is 2 to 6 capital letters or digits." };
    value.reference_prefix = prefix || null;
  }
  if ("defaultCurrency" in payload) {
    const currency = text("defaultCurrency").toUpperCase();
    if (currency && !(CURRENCIES as readonly string[]).includes(currency)) {
      return { error: `Currency must be one of: ${CURRENCIES.join(", ")}.` };
    }
    value.default_currency = currency;
  }
  return { value };
}

export interface TeamSettings {
  defaultEntityId: string | null;
  email: string;
  approverIds: string[];
}

/** The team admin's half of a team (default entity, email, approvers),
 *  checked for shape; the caller checks the ids exist. */
export function normalizeTeamSettings(payload: Record<string, unknown>): { value: TeamSettings } | { error: string } {
  const entity = typeof payload.defaultEntityId === "string" && payload.defaultEntityId ? payload.defaultEntityId : null;
  if (entity && !isUuid(entity)) return { error: "Invalid default entity." };
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (email && !isEmail(email)) return { error: "The team email is not an email address." };
  if (email.length > 200) return { error: "The team email is too long." };
  const ids = (key: string): string[] | null => {
    const raw = payload[key];
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.some((v) => !isUuid(v))) return null;
    return [...new Set(raw as string[])];
  };
  const approverIds = ids("approverIds");
  if (!approverIds) return { error: "Approvers must be a list of people." };
  if (approverIds.length > 50) return { error: "A team can have at most 50 default approvers." };
  return { value: { defaultEntityId: entity, email, approverIds } };
}
