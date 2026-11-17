// PostgREST caps a response at db.max-rows (1000 by default) and truncates
// silently. Any query over a whole table must page until a short page. Callers
// pass a factory so each page gets a fresh builder, and every query needs a
// stable .order for the ranges to line up.

const FEED_PAGE_SIZE = 1000;

export async function selectAllRows(
  // deno-lint-ignore no-explicit-any
  makeQuery: () => any,
): Promise<{ data: Record<string, unknown>[]; error: { message: string } | null }> {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += FEED_PAGE_SIZE) {
    const { data, error } = await makeQuery().range(offset, offset + FEED_PAGE_SIZE - 1);
    if (error) {
      return { data: rows, error };
    }
    const page = data ?? [];
    rows.push(...page);
    if (page.length < FEED_PAGE_SIZE) {
      return { data: rows, error: null };
    }
  }
}

/** A `.in()` read over a possibly long id list: chunked so the URL stays
 *  bounded, each chunk paged so it can't truncate, then merged. The factory
 *  must give every builder a stable .order. */
export async function selectForIds(
  ids: readonly string[],
  // deno-lint-ignore no-explicit-any
  makeQuery: (chunk: string[]) => any,
): Promise<{ data: Record<string, unknown>[]; error: { message: string } | null }> {
  const CHUNK = 150;
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const paged = await selectAllRows(() => makeQuery(chunk));
    if (paged.error) return { data: rows, error: paged.error };
    rows.push(...paged.data);
  }
  return { data: rows, error: null };
}
