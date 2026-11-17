import { internalError, jsonResponse } from "../_shared/http.ts";
import { withAuthorizedCaller } from "../_shared/serve.ts";
import type { ServiceClient } from "../_shared/service-client.ts";
import {
  ACCESS_ENTITIES as ENTITIES,
  ACCESS_NO_OWN_ENTITIES,
  ACCESS_READONLY_ENTITIES,
  LANDING_ENTITY,
} from "../_shared/vocabularies.ts";
import { MAX_NAME, isUuid, overMaxLength } from "../_shared/validation.ts";
import { requirePermission } from "../_shared/permissions.ts";
import { loadOrgLocale } from "../_shared/organisation-locale.ts";

// The RBAC vocabulary lives in _shared/vocabularies.ts, drift-tested against
// src/lib/constants.ts.
const READONLY_ENTITIES = new Set<string>(ACCESS_READONLY_ENTITIES);
const NO_OWN_ENTITIES = new Set<string>(ACCESS_NO_OWN_ENTITIES);

/** Own (1) on an entity that can't scope becomes All (2): access is what was
 *  meant, and a stored 1 would look like a narrower grant no code honours. */
function scopeFor(entity: string, value: number): number {
  return NO_OWN_ENTITIES.has(entity) && value === 1 ? 2 : value;
}

// LANDING_ENTITY also comes from _shared/vocabularies.ts, drift-tested against
// LANDING_PAGES client-side.

// Keep a landing path only if it's known and the role can read its entity;
// else null (the app default), so nobody lands on a locked screen.
function resolveLandingPath(
  raw: unknown,
  permRows: Array<{ entity: string; read_level: number }>,
): string | null {
  const path = typeof raw === "string" ? raw.trim() : "";
  const entity = LANDING_ENTITY[path];
  if (!entity) return null;
  const row = permRows.find((r) => r.entity === entity);
  return row && row.read_level > 0 ? path : null;
}

// Managing roles (and seeing who holds them) needs write on this entity. The
// account actions (invite, disable, delete, MFA) are in people_administration.
const MANAGE_ENTITY = "Users & Access Roles";

interface PermissionInput {
  entity: string;
  readLevel: number;
  writeLevel: number;
  deleteLevel: number;
}

// Clamp any input to a valid access level (0 None, 1 Own, 2 All).
function level(value: unknown): number {
  const n = typeof value === "number" ? Math.trunc(value) : Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : 0;
}

// One clean row per known entity, with the non-read columns of read-only
// entities zeroed so the store matches the greyed-out form.
function normalizePermissions(raw: unknown): Array<{
  entity: string;
  read_level: number;
  write_level: number;
  delete_level: number;
}> {
  const byEntity = new Map<string, PermissionInput>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const entity = typeof (item as PermissionInput)?.entity === "string" ? (item as PermissionInput).entity : "";
      if (!(ENTITIES as readonly string[]).includes(entity)) continue;
      byEntity.set(entity, item as PermissionInput);
    }
  }
  const rows: { entity: string; read_level: number; write_level: number; delete_level: number }[] = [];
  for (const [entity, p] of byEntity) {
    const readonly = READONLY_ENTITIES.has(entity);
    rows.push({
      entity,
      read_level: scopeFor(entity, level(p.readLevel)),
      write_level: readonly ? 0 : scopeFor(entity, level(p.writeLevel)),
      delete_level: readonly ? 0 : scopeFor(entity, level(p.deleteLevel)),
    });
  }
  return rows;
}

/** Whether a permission matrix grants administration (Users & Access Roles write). */
function grantsAdministration(rows: Array<{ entity: string; write_level: number }>): boolean {
  return rows.some((r) => r.entity === MANAGE_ENTITY && r.write_level > 0);
}

const LAST_ADMIN_ROLE_ERROR =
  "This role is what makes the last administrator an administrator. Give somebody else Access Roles write through another role first, or there will be nobody left who can restore access.";

/**
 * Would there be no administrator left if this role stopped counting?
 * people_administration asks the same of a person; this asks it of a role
 * about to lose the grant, be disabled or be deleted. Fails closed: an
 * unreadable answer refuses.
 */
async function roleIsLastAdministration(serviceClient: ServiceClient, roleId: string): Promise<boolean> {
  const { data, error } = await serviceClient.rpc("other_active_administrators", {
    p_exclude_user: null,
    p_exclude_role: roleId,
  });
  if (error) {
    console.error("other_active_administrators failed:", error.message ?? error);
    return true;
  }
  return (typeof data === "number" ? data : 0) < 1;
}

/** The permission rows a role holds now. */
async function rolePermissionRows(serviceClient: ServiceClient, roleId: string) {
  const { data } = await serviceClient
    .from("access_role_permissions")
    .select("entity, read_level, write_level, delete_level")
    .eq("role_id", roleId)
    .order("entity");
  return (data ?? []) as Array<{ entity: string; read_level: number; write_level: number; delete_level: number }>;
}

Deno.serve((request) =>
  withAuthorizedCaller(request, async ({ request, serviceClient, callerId }) => {

  // The caller's own effective access (max across their enabled roles) and
  // landing page. Before the manage gate on purpose: everyone may read their own
  // access (the UI locks nav with it), and it shows nothing about anyone else.
  if (request.method === "GET" && new URL(request.url).searchParams.get("resource") === "me") {
    const { data: assignments, error: asgErr } = await serviceClient
      .from("user_access_roles").select("role_id").eq("user_id", callerId);
    if (asgErr) return internalError(request, asgErr, "my access assignments");
    const roleIds = [...new Set((assignments ?? []).map((a: { role_id: string }) => a.role_id))];

    const { data: myRoles, error: rolesErr } = roleIds.length === 0
      ? { data: [], error: null }
      : await serviceClient
          .from("access_roles").select("id, name, landing_path").eq("enabled", true).in("id", roleIds);
    if (rolesErr) return internalError(request, rolesErr, "my access roles");
    const enabledIds = (myRoles ?? []).map((r: { id: string }) => r.id);

    const { data: perms, error: permErr } = enabledIds.length === 0
      ? { data: [], error: null }
      : await serviceClient
          .from("access_role_permissions")
          .select("entity, read_level, write_level, delete_level")
          .in("role_id", enabledIds);
    if (permErr) return internalError(request, permErr, "my access permissions");

    // One row per entity, max per action.
    const merged = new Map<string, { readLevel: number; writeLevel: number; deleteLevel: number }>();
    for (const p of perms ?? []) {
      const entity = p.entity as string;
      const row = merged.get(entity) ?? { readLevel: 0, writeLevel: 0, deleteLevel: 0 };
      row.readLevel = Math.max(row.readLevel, typeof p.read_level === "number" ? p.read_level : 0);
      row.writeLevel = Math.max(row.writeLevel, typeof p.write_level === "number" ? p.write_level : 0);
      row.deleteLevel = Math.max(row.deleteLevel, typeof p.delete_level === "number" ? p.delete_level : 0);
      merged.set(entity, row);
    }
    // A switched-off entity grants nothing, so its pages leave the rail.
    const locale = await loadOrgLocale(serviceClient);
    if (!locale.clientsEnabled) merged.delete("Clients");
    if (!locale.engagementsEnabled) merged.delete("Engagements");
    const permissions = [...merged].map(([entity, levels]) => ({ entity, ...levels }));

    // The landing page: the first enabled role (by name) whose page the caller can
    // actually read, rechecked so a stale role edit can't land them on a locked page.
    const sortedRoles = [...(myRoles ?? [])].sort((a, b) =>
      String(a.name ?? "").localeCompare(String(b.name ?? "")),
    );
    let landingPath: string | null = null;
    for (const role of sortedRoles) {
      const path = typeof role.landing_path === "string" ? role.landing_path : "";
      const entity = LANDING_ENTITY[path];
      if (entity && (merged.get(entity)?.readLevel ?? 0) > 0) {
        landingPath = path;
        break;
      }
    }

    return jsonResponse({ permissions, landingPath }, request);
  }

  // Everything here administers roles, so gate the whole function on write for
  // Users & Access Roles.
  const manage = await requirePermission(serviceClient, callerId, MANAGE_ENTITY, "write");
  if (!manage.ok) {
    return jsonResponse({ error: "You don't have permission to manage access roles." }, request, manage.status);
  }

  // Reads
  if (request.method === "GET") {
    const url = new URL(request.url);
    const resource = url.searchParams.get("resource");

    // Who holds which roles, for the roles drawer's "N users assigned".
    if (resource === "users") {
      const { data: assignments, error: asgErr } = await serviceClient
        .from("user_access_roles")
        .select("user_id, role_id");
      if (asgErr) return internalError(request, asgErr, "access role assignments");

      const rolesByUser = new Map<string, string[]>();
      for (const a of assignments ?? []) {
        const uid = a.user_id as string;
        rolesByUser.set(uid, [...(rolesByUser.get(uid) ?? []), a.role_id as string]);
      }
      const users = [...rolesByUser].map(([userId, roleIds]) => ({ userId, roleIds }));
      return jsonResponse({ users }, request);
    }

    // Default: every role with its permission matrix.
    const { data: roles, error: rolesErr } = await serviceClient
      .from("access_roles")
      .select("id, name, is_system, enabled, landing_path, created_at")
      .order("is_system", { ascending: false })
      .order("name", { ascending: true });
    if (rolesErr) return internalError(request, rolesErr, "access role list");

    const { data: perms, error: permErr } = await serviceClient
      .from("access_role_permissions")
      .select("role_id, entity, read_level, write_level, delete_level");
    if (permErr) return internalError(request, permErr, "access role permissions");

    const permsByRole = new Map<string, unknown[]>();
    for (const p of perms ?? []) {
      const rid = p.role_id as string;
      if (!permsByRole.has(rid)) permsByRole.set(rid, []);
      permsByRole.get(rid)!.push({
        entity: p.entity,
        readLevel: p.read_level,
        writeLevel: p.write_level,
        deleteLevel: p.delete_level,
      });
    }

    const items = (roles ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      isSystem: r.is_system,
      enabled: r.enabled,
      landingPath: r.landing_path,
      createdAt: r.created_at,
      permissions: permsByRole.get(r.id as string) ?? [],
    }));
    return jsonResponse({ roles: items }, request);
  }

  // Mutations
  let payload: Record<string, unknown> = {};
  try {
    payload = await request.json();
  } catch {
    payload = {};
  }
  const action = typeof payload.action === "string" ? payload.action.trim().toLowerCase() : "";

  // User management (invite, edit, roles, disable, delete, MFA reset) is in
  // people_administration, since a person and their login are one thing. This
  // function only manages the roles.
  const createRole = async (): Promise<Response> => {
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!name) return jsonResponse({ error: "A role name is required." }, request, 400);
    if (overMaxLength(name, MAX_NAME)) return jsonResponse({ error: `Name must be ${MAX_NAME} characters or fewer.` }, request, 400);

    const enabled = payload.enabled !== false; // default enabled
    const permRows = normalizePermissions(payload.permissions);
    const landingPath = resolveLandingPath(payload.landingPath, permRows);
    const { data: created, error } = await serviceClient
      .from("access_roles")
      .insert({ name, enabled, landing_path: landingPath, created_by: callerId })
      .select("id")
      .single();
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return jsonResponse({ error: "A role with that name already exists." }, request, 409);
      }
      return internalError(request, error, "access role insert");
    }

    const rows = permRows.map((r) => ({ role_id: created!.id, ...r }));
    if (rows.length > 0) {
      const { error: permErr } = await serviceClient.from("access_role_permissions").insert(rows);
      if (permErr) return internalError(request, permErr, "access role permissions insert");
    }
    return jsonResponse({ message: "Access role created.", id: created!.id }, request);
  };

  const updateRole = async (): Promise<Response> => {
    const id = typeof payload.id === "string" ? payload.id : "";
    if (!isUuid(id)) return jsonResponse({ error: "A valid role id is required." }, request, 400);

    // The built-in Administrator can't be edited, only assigned.
    const { data: existing, error: readErr } = await serviceClient
      .from("access_roles").select("is_system").eq("id", id).single();
    if (readErr) return internalError(request, readErr, "access role read");
    if (existing?.is_system) return jsonResponse({ error: "The built-in Administrator role can't be changed." }, request, 400);

    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    const enabled = payload.enabled !== false;
    if (!name) return jsonResponse({ error: "A role name is required." }, request, 400);
    if (overMaxLength(name, MAX_NAME)) return jsonResponse({ error: `Name must be ${MAX_NAME} characters or fewer.` }, request, 400);

    const permRows = normalizePermissions(payload.permissions);
    const landingPath = resolveLandingPath(payload.landingPath, permRows);
    const before = await rolePermissionRows(serviceClient, id);
    // A role that would stop granting administration (grant removed, or role
    // switched off) must not be the last one doing so.
    const losesAdministration = grantsAdministration(before) && (!enabled || !grantsAdministration(permRows));
    if (losesAdministration && (await roleIsLastAdministration(serviceClient, id))) {
      return jsonResponse({ error: LAST_ADMIN_ROLE_ERROR }, request, 400);
    }
    const { error } = await serviceClient
      .from("access_roles")
      .update({ name, enabled, landing_path: landingPath, updated_at: new Date().toISOString(), updated_by: callerId })
      .eq("id", id);
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return jsonResponse({ error: "A role with that name already exists." }, request, 409);
      }
      return internalError(request, error, "access role update");
    }

    // Replace the matrix in one transaction: a separate delete and insert could
    // leave the role granting nothing, locking out everyone who held it.
    const { error: permErr } = await serviceClient.rpc("replace_role_permissions", { p_role_id: id, p_rows: permRows });
    if (permErr) return internalError(request, permErr, "access role permissions replace");
    return jsonResponse({ message: "Access role updated." }, request);
  };

  // Quick enable/disable toggle from the list, without resending the matrix.
  const setRoleEnabled = async (): Promise<Response> => {
    const id = typeof payload.id === "string" ? payload.id : "";
    if (!isUuid(id)) return jsonResponse({ error: "A valid role id is required." }, request, 400);
    const { data: existing, error: readErr } = await serviceClient
      .from("access_roles").select("is_system").eq("id", id).single();
    if (readErr) return internalError(request, readErr, "access role read");
    if (existing?.is_system) return jsonResponse({ error: "The built-in Administrator role can't be disabled." }, request, 400);
    const enabling = payload.enabled === true;
    // Switching off the last role that grants administration.
    if (!enabling && grantsAdministration(await rolePermissionRows(serviceClient, id)) && (await roleIsLastAdministration(serviceClient, id))) {
      return jsonResponse({ error: LAST_ADMIN_ROLE_ERROR }, request, 400);
    }

    const { error } = await serviceClient
      .from("access_roles")
      .update({ enabled: enabling, updated_at: new Date().toISOString(), updated_by: callerId })
      .eq("id", id);
    if (error) return internalError(request, error, "access role set_enabled");
    return jsonResponse({ message: "Access role updated." }, request);
  };

  const deleteRole = async (): Promise<Response> => {
    const id = typeof payload.id === "string" ? payload.id : "";
    if (!isUuid(id)) return jsonResponse({ error: "A valid role id is required." }, request, 400);
    const { data: existing, error: readErr } = await serviceClient
      .from("access_roles").select("is_system").eq("id", id).single();
    if (readErr) return internalError(request, readErr, "access role read");
    if (existing?.is_system) return jsonResponse({ error: "The built-in Administrator role can't be deleted." }, request, 400);
    const before = await rolePermissionRows(serviceClient, id);
    // Deleting the last role that grants administration takes every holder's
    // grant with it.
    if (grantsAdministration(before) && (await roleIsLastAdministration(serviceClient, id))) {
      return jsonResponse({ error: LAST_ADMIN_ROLE_ERROR }, request, 400);
    }

    // Assignments cascade away with the role.
    const { error } = await serviceClient.from("access_roles").delete().eq("id", id);
    if (error) return internalError(request, error, "access role delete");
    return jsonResponse({ message: "Access role deleted." }, request);
  };

  // One table binds each mutation to its permission. They all need write on
  // MANAGE_ENTITY, checked by the gate above (delete included).
  const MUTATIONS: Record<string, () => Promise<Response>> = {
    create: createRole,
    update: updateRole,
    set_enabled: setRoleEnabled,
    delete: deleteRole,
  };
  const run = Object.hasOwn(MUTATIONS, action) ? MUTATIONS[action] : undefined;
  if (!run) return jsonResponse({ error: `Unknown action: ${action}` }, request, 400);
  return run();
  }));
