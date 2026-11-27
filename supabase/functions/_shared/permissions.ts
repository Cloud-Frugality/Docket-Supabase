// Server-side RBAC. Every business function calls requirePermission right
// after assertAuthorizedCaller; the functions are the security boundary, so
// this is what makes access roles real.
//
// Each enabled role grants a level per entity and action (0 None, 1 Own,
// 2 All), and a user's level is the max across their roles. The level comes
// back with the verdict so a function can scope its records. Own means:
// clients you created, engagements a team of yours owns, files you uploaded.
//
// Import-free apart from the structural ServiceClient type, so the tests run
// this file.

import type { ServiceClient } from "./service-client.ts";

export type AccessAction = "read" | "write" | "delete";

/** The rungs a permission cell can hold (0 = none). */
export const LEVEL_OWN = 1;
export const LEVEL_ALL = 2;

const LEVEL_COLUMN = {
  read: "read_level",
  write: "write_level",
  delete: "delete_level",
} as const;

// How a denial reads to the user, per action.
const ACTION_VERB: Record<AccessAction, string> = {
  read: "view",
  write: "make changes to",
  delete: "delete from",
};

export interface PermissionRow {
  read_level: number;
  write_level: number;
  delete_level: number;
}

/** The effective level for one action across every enabled role the user
 *  holds: the max. */
export function maxLevel(rows: PermissionRow[], action: AccessAction): number {
  let max = 0;
  for (const row of rows) {
    const value = row?.[LEVEL_COLUMN[action]];
    const level = typeof value === "number" ? value : 0;
    if (level > max) max = level;
  }
  return max;
}

/**
 * The level comes back with the verdict because Own and All both answer "may
 * you?" but differ on "which ones?". Gate on `.ok`, scope on `.level`.
 */
export type PermissionResult =
  | { ok: true; level: number }
  | { ok: false; status: 403; error: string };

/**
 * Whether a record is the caller's own.
 *
 * The owner wins, because ownership transfers when work is reassigned and
 * creation doesn't. The creator is the fallback when nobody owns it, because
 * owner fields are optional and a record shouldn't vanish from its creator's
 * view just because they forgot to set one.
 *
 * `ownerUserId` is the owner's profile id, which is their login id.
 */
export function isOwnRecord(
  ownerUserId: string | null,
  createdBy: string | null,
  callerId: string,
): boolean {
  if (ownerUserId) return ownerUserId === callerId;
  return !!createdBy && createdBy === callerId;
}

/** The caller's level for (entity, action) in one round trip: the
 *  `caller_permission_levels` SQL function does the join and the max.
 *  Fails closed: no roles, disabled roles, an RPC error or a bad row all mean
 *  level 0. */
export async function callerLevel(
  serviceClient: Pick<ServiceClient, "rpc">,
  callerId: string,
  entity: string,
  action: AccessAction,
): Promise<number> {
  const { data, error } = await serviceClient
    .rpc("caller_permission_levels", { p_user: callerId, p_entity: entity });
  if (error) {
    // Visible in function logs; the caller just sees a denial (fail closed).
    console.error("caller_permission_levels failed:", error.message ?? error);
    return 0;
  }
  return maxLevel((data ?? []) as PermissionRow[], action);
}

/** Who the caller is in the team structure. It lives here because every
 *  function bundles this file: a type-only import from elsewhere is erased
 *  by the bundler and reads as drift on deploy. */
export interface CallerTeams {
  /** Holds Users & Access Roles write: every team rule passes. */
  globalAdmin: boolean;
  teamIds: readonly string[];
  /** The teams the caller is team admin of. */
  adminTeamIds: readonly string[];
}

/**
 * The caller's teams, for the team rules on top of the access roles. A global
 * admin is anyone with Users & Access Roles write. Fails closed: an unreadable
 * membership means no teams.
 */
export async function callerTeams(
  serviceClient: Pick<ServiceClient, "from" | "rpc">,
  callerId: string,
): Promise<CallerTeams> {
  const [adminLevel, { data, error }] = await Promise.all([
    callerLevel(serviceClient, callerId, "Users & Access Roles", "write"),
    serviceClient.from("team_members").select("team_id, role").eq("user_id", callerId),
  ]);
  if (error) console.error("callerTeams failed:", error.message ?? error);
  const rows = (error ? [] : (data ?? [])) as Array<{ team_id: unknown; role: unknown }>;
  return {
    // All, not Own: Own on this entity is refused when a role is saved, but a stray one must not make an admin.
    globalAdmin: adminLevel >= LEVEL_ALL,
    teamIds: rows.map((r) => String(r.team_id)),
    adminTeamIds: rows.filter((r) => r.role === "team_admin").map((r) => String(r.team_id)),
  };
}

/** The gate the functions call: ok at Own or All, else a 403 payload for the
 *  caller to wrap in its jsonResponse. */
export async function requirePermission(
  serviceClient: Pick<ServiceClient, "rpc">,
  callerId: string,
  entity: string,
  action: AccessAction,
): Promise<PermissionResult> {
  const level = await callerLevel(serviceClient, callerId, entity, action);
  if (level > 0) return { ok: true, level };
  return { ok: false, status: 403, error: `You don't have permission to ${ACTION_VERB[action]} ${entity}.` };
}
