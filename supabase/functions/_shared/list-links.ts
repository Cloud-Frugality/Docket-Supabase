// Which business units an engagement type is offered to, and which engagement
// types and business units a document category is offered to. One rule
// throughout: nothing listed means everyone. Pure, so the tests run this
// file; mirrored in src/lib/list-links.ts.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether something limited to `limit` is offered to `id`. No limit is
 *  everyone; with one, something with no id at all (a team in no business
 *  unit) is left out. */
export function isOffered(limit: readonly string[], id: string | null): boolean {
  return limit.length === 0 || (id !== null && limit.includes(id));
}

/** A list of ids from a payload, each once; absent is none, anything else null. */
export function idList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || !UUID_RE.test(v))) return null;
  return [...new Set(raw as string[])];
}

/**
 * Why a category can't be used for this team and engagement type, or null.
 * `typeId` is null for a template for any type, and `unitId` for an
 * organisation template or a team in no business unit; an organisation
 * template isn't held to business units, since every team uses it.
 */
export function categoryOfferError(
  category: { name: string; typeIds: readonly string[]; unitIds: readonly string[] },
  typeId: string | null,
  unitId: string | null,
  checkUnit: boolean,
): string | null {
  if (typeId !== null && !isOffered(category.typeIds, typeId)) return `${category.name} is not offered for that engagement type.`;
  if (checkUnit && !isOffered(category.unitIds, unitId)) return `${category.name} is not offered to that team's business unit.`;
  return null;
}
