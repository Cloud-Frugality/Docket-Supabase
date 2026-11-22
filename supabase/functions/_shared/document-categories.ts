// The types a file on one record may be. Client and engagement files pick
// from the document categories global admins keep; an engagement's are held
// to the categories offered for its type and its team's business unit. A
// feature request's attachments keep their own short list.
import type { ServiceClient } from "./service-client.ts";
import { isOffered } from "./list-links.ts";
import { FEATURE_REQUEST_DOCUMENT_TYPES, type AllowedTypes, type DocumentRecord } from "./document-rules.ts";
import { storedFields } from "./document-fields.ts";

type Row = Record<string, unknown>;
const ids = (rows: unknown, key: string) => ((rows ?? []) as Row[]).map((r) => String(r[key]));

/**
 * `entityId` is the client or engagement; null when it isn't saved yet, which
 * offers every active category. `keep` is the type a file already has, which
 * stays allowed even when its category has since been switched off.
 */
export async function allowedDocumentTypes(
  serviceClient: ServiceClient,
  record: DocumentRecord,
  entityId: string | null,
  keep: string | null = null,
): Promise<AllowedTypes> {
  if (record === "feature_request") return { types: [...FEATURE_REQUEST_DOCUMENT_TYPES], binding: [] };

  const [categories, engagement] = await Promise.all([
    serviceClient
      .from("document_categories")
      .select("name, is_active, is_binding, fields, document_category_engagement_types(engagement_type_id), document_category_business_units(business_unit_id)")
      .order("sort_order").order("id"),
    record === "engagement" && entityId
      ? serviceClient.from("engagements").select("engagement_type_id, teams(business_unit_id)").eq("id", entityId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const failed = categories.error ?? engagement.error;
  if (failed) throw failed;

  const rows = (categories.data ?? []) as Row[];
  const of = engagement.data as Row | null;
  const typeId = typeof of?.engagement_type_id === "string" ? of.engagement_type_id : null;
  const unit = (of?.teams as Row | null)?.business_unit_id;
  const unitId = typeof unit === "string" ? unit : null;
  const offered = (c: Row) =>
    !of ||
    (isOffered(ids(c.document_category_engagement_types, "engagement_type_id"), typeId) &&
      isOffered(ids(c.document_category_business_units, "business_unit_id"), unitId));

  return {
    types: rows.filter((c) => c.name === keep || (c.is_active === true && offered(c))).map((c) => String(c.name)),
    binding: rows.filter((c) => c.is_binding === true).map((c) => String(c.name)),
    fields: Object.fromEntries(rows.map((c) => [String(c.name), storedFields(c.fields)])),
  };
}
