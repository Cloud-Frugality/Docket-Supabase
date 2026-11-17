// Listing and saving legal entities, shared by client_administration (a
// client's) and team_administration (ours, client_id null). Each caller checks
// its own grant first; this validates the row and keeps one default per side.
import type { ServiceClient } from "./service-client.ts";
import { entityDeactivateError, entityDeleteError, normalizeEntity } from "./engagement-rules.ts";
import { isUniqueViolation, isUuid } from "./validation.ts";
import { loadOrgLocale } from "./organisation-locale.ts";

export interface EntityResult {
  status: number;
  body: Record<string, unknown>;
}

const COLUMNS =
  "id, client_id, registered_name, trading_name, registration_number, tax_number, address_line_1, address_line_2, city, province, postal_code, country_code, is_default, is_active";

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A row as the app sees it. */
export function entityOf(r: Record<string, unknown>) {
  return {
    id: str(r.id),
    clientId: typeof r.client_id === "string" ? r.client_id : null,
    registeredName: str(r.registered_name),
    tradingName: str(r.trading_name),
    registrationNumber: str(r.registration_number),
    taxNumber: str(r.tax_number),
    addressLine1: str(r.address_line_1),
    addressLine2: str(r.address_line_2),
    city: str(r.city),
    province: str(r.province),
    postalCode: str(r.postal_code),
    countryCode: str(r.country_code),
    isDefault: r.is_default === true,
    isActive: r.is_active === true,
  };
}

/** One side's entities, default first, then by name. */
export async function listEntities(serviceClient: ServiceClient, clientId: string | null): Promise<EntityResult> {
  let query = serviceClient.from("legal_entities").select(COLUMNS);
  query = clientId ? query.eq("client_id", clientId) : query.is("client_id", null);
  const { data, error } = await query.order("is_default", { ascending: false }).order("registered_name");
  if (error) {
    console.error("listEntities:", error.message);
    return { status: 500, body: { error: "Unable to load the legal entities." } };
  }
  return { status: 200, body: { entities: (data ?? []).map(entityOf) } };
}

/**
 * Create (no entityId) or update one entity on one side. The first entity a
 * side gets becomes its default; `makeDefault` moves the default to it. A
 * default cannot be switched off.
 */
export async function saveEntity(
  serviceClient: ServiceClient,
  clientId: string | null,
  payload: Record<string, unknown>,
  callerId: string,
): Promise<EntityResult> {
  const details = normalizeEntity(payload);
  if ("error" in details) return { status: 400, body: { error: details.error } };
  // Locked to one country, the organisation's is the only one saved.
  const locale = await loadOrgLocale(serviceClient);
  if (locale.lockCountry) details.value.country_code = locale.defaultCountryCode;
  const entityId = typeof payload.entityId === "string" && payload.entityId ? payload.entityId : null;
  if (entityId && !isUuid(entityId)) return { status: 400, body: { error: "Invalid entityId." } };
  const isActive = payload.isActive !== false;
  const makeDefault = payload.makeDefault === true;
  if (makeDefault && !isActive) return { status: 400, body: { error: "A switched-off entity cannot be the default." } };

  let sideQuery = serviceClient.from("legal_entities").select("id, is_default");
  sideQuery = clientId ? sideQuery.eq("client_id", clientId) : sideQuery.is("client_id", null);
  const { data: side, error: sideError } = await sideQuery;
  if (sideError) return { status: 500, body: { error: "Unable to load the legal entities." } };
  const existing = entityId ? (side ?? []).find((e) => e.id === entityId) : null;
  if (entityId && !existing) return { status: 404, body: { error: "Entity not found." } };
  const deactivate = entityDeactivateError(existing?.is_default === true, isActive);
  if (deactivate) return { status: 400, body: { error: deactivate } };

  let id = entityId;
  if (entityId) {
    const { error } = await serviceClient
      .from("legal_entities")
      .update({ ...details.value, is_active: isActive, updated_at: new Date().toISOString(), updated_by: callerId })
      .eq("id", entityId);
    if (error) {
      if (isUniqueViolation(error)) return { status: 409, body: { error: "An entity with that registered name already exists here." } };
      console.error("saveEntity update:", error.message);
      return { status: 500, body: { error: "Unable to save the entity." } };
    }
  } else {
    const { data: org, error: orgError } = await serviceClient
      .from("organisations").select("id").order("created_at").limit(1).single();
    if (orgError) return { status: 500, body: { error: "Unable to read the organisation." } };
    const { data, error } = await serviceClient
      .from("legal_entities")
      .insert({
        organisation_id: org.id,
        client_id: clientId,
        ...details.value,
        is_active: isActive,
        // The first on its side is the default: documents always have one.
        is_default: (side ?? []).length === 0,
        created_by: callerId,
      })
      .select("id")
      .single();
    if (error) {
      if (isUniqueViolation(error)) return { status: 409, body: { error: "An entity with that registered name already exists here." } };
      console.error("saveEntity insert:", error.message);
      return { status: 500, body: { error: "Unable to create the entity." } };
    }
    id = String(data.id);
  }

  if (makeDefault && id) {
    const { error } = await serviceClient.rpc("set_default_legal_entity", { p_entity_id: id, p_actor: callerId });
    if (error) {
      console.error("set_default_legal_entity:", error.message);
      return { status: 500, body: { error: "The entity was saved, but could not be made the default." } };
    }
  }
  return { status: 200, body: { message: "Entity saved.", id } };
}

/** Delete one of a side's entities, if nothing names it. */
export async function deleteEntity(serviceClient: ServiceClient, clientId: string | null, entityId: unknown): Promise<EntityResult> {
  if (!isUuid(entityId)) return { status: 400, body: { error: "Invalid entityId." } };
  let query = serviceClient.from("legal_entities").select("id, is_default").eq("id", entityId);
  query = clientId ? query.eq("client_id", clientId) : query.is("client_id", null);
  const { data: entity, error } = await query.maybeSingle();
  if (error) return { status: 500, body: { error: "Unable to load the entity." } };
  if (!entity) return { status: 404, body: { error: "Entity not found." } };

  const count = { count: "exact" as const, head: true };
  const [engagements, teams, people] = await Promise.all([
    serviceClient.from("engagements").select("id", count).or(`our_entity_id.eq.${entityId},client_entity_id.eq.${entityId}`),
    serviceClient.from("teams").select("id", count).eq("default_entity_id", entityId),
    serviceClient.from("profiles").select("id", count).eq("employing_entity_id", entityId),
  ]);
  if (engagements.error || teams.error || people.error) return { status: 500, body: { error: "Unable to check where the entity is used." } };
  const refused = entityDeleteError(entity.is_default === true, {
    engagements: engagements.count ?? 0,
    teams: teams.count ?? 0,
    people: people.count ?? 0,
  });
  if (refused) return { status: 409, body: { error: refused } };

  const { error: deleteError } = await serviceClient.from("legal_entities").delete().eq("id", entityId);
  if (deleteError) {
    console.error("deleteEntity:", deleteError.message);
    // Something named it between the check and the delete.
    return { status: 409, body: { error: "This entity is in use. Switch it off instead." } };
  }
  return { status: 200, body: { message: "Entity deleted." } };
}

/** The entity, if it's one of this side's live ones. Used to check an
 *  engagement's or team's default choice. */
export async function isLiveEntityOf(
  serviceClient: ServiceClient,
  entityId: string,
  clientId: string | null,
): Promise<boolean> {
  if (!isUuid(entityId)) return false;
  let query = serviceClient.from("legal_entities").select("id").eq("id", entityId).eq("is_active", true);
  query = clientId ? query.eq("client_id", clientId) : query.is("client_id", null);
  const { data } = await query.maybeSingle();
  return !!data;
}
