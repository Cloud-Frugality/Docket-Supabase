import type { ServiceClient } from "./service-client.ts";
import { selectForIds } from "./paging.ts";

const ADMIN_LOOKUP_GROUP = 20;

export function resolveDisplayName(
  email: string,
  metadata: Record<string, unknown> | null | undefined,
): string {
  const metadataDisplayName =
    typeof metadata?.display_name === "string" ? metadata.display_name.trim() : "";
  if (metadataDisplayName) {
    return metadataDisplayName;
  }

  const metadataFullName =
    typeof metadata?.full_name === "string" ? metadata.full_name.trim() : "";
  if (metadataFullName) {
    return metadataFullName;
  }

  const localPart = (email ?? "").split("@", 1)[0]?.trim() ?? "";
  return localPart || "Unknown";
}

/**
 * Map of user id to display name. Reads profiles first and falls back to
 * auth.admin.getUserById for ids no profile covered. Uses the service client
 * because the admin API needs it and profiles has no authenticated read policy.
 */
export async function buildDisplayNameMap(
  serviceClient: ServiceClient,
  userIds: Iterable<string>,
): Promise<Map<string, string>> {
  const ids = Array.from(
    new Set(
      Array.from(userIds).filter((id) => typeof id === "string" && id.trim().length > 0),
    ),
  );
  const displayNameById = new Map<string, string>();

  if (ids.length === 0) {
    return displayNameById;
  }

  // Chunked and paged: one `.in()` over a long id list breaks the URL, and an
  // unranged read stops at 1,000 rows.
  const { data, error } = await selectForIds(ids, (chunk) =>
    serviceClient.from("profiles").select("id, full_name").in("id", chunk).order("id")
  );

  if (!error) {
    for (const row of data ?? []) {
      const id = typeof row.id === "string" ? row.id : "";
      const name = typeof row.full_name === "string" ? row.full_name.trim() : "";
      if (id && name) displayNameById.set(id, name);
    }
  }

  // Admin API fallback, only for ids a profile didn't resolve.
  const missing = ids.filter((id) => !displayNameById.has(id));
  // In groups, or a thousand unresolved ids means a thousand concurrent admin
  // calls.
  for (let i = 0; i < missing.length; i += ADMIN_LOOKUP_GROUP) {
    const userResults = await Promise.all(
      missing.slice(i, i + ADMIN_LOOKUP_GROUP).map((userId) => serviceClient.auth.admin.getUserById(userId)),
    );
    for (const { data: userData } of userResults) {
      const user = userData?.user;
      if (!user) {
        continue;
      }
      displayNameById.set(
        user.id,
        resolveDisplayName(
          user.email ?? "",
          user.user_metadata as Record<string, unknown> | null | undefined,
        ),
      );
    }
  }

  return displayNameById;
}
