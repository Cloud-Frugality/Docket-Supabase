import type { ServiceClient } from "./service-client.ts";
import { binCutoff } from "./document-rules.ts";

// Where removed files live, and the bucket their bytes are in.
const BIN_TABLES = [
  { table: "client_documents", bucket: "client-documents" },
  { table: "engagement_documents", bucket: "engagement-documents" },
] as const;

/** Files deleted per table on one pass. */
const BATCH = 50;

/**
 * Deletes for good the removed files that have been in the recycle bin longer
 * than the organisation keeps them, one batch at a time. A file on hold or
 * still retained is left, however long it has been there. Returns how many
 * went, so the nightly job (bin_sweep) knows when it is done; a failure is
 * logged and counts as none.
 */
export async function sweepBin(serviceClient: ServiceClient, today: string): Promise<number> {
  let deleted = 0;
  try {
    const { data: org, error: orgError } = await serviceClient
      .from("organisations").select("bin_retention_days").order("created_at").limit(1).single();
    if (orgError) throw orgError;
    const days = typeof org.bin_retention_days === "number" ? org.bin_retention_days : null;
    if (!days) return 0;
    const cutoff = binCutoff(new Date(), days);
    for (const { table, bucket } of BIN_TABLES) {
      const { data, error } = await serviceClient
        .from(table)
        .select("id, storage_path")
        .lt("archived_at", cutoff)
        .eq("on_hold", false)
        .or(`retain_until.is.null,retain_until.lte.${today}`)
        .order("archived_at")
        .limit(BATCH);
      if (error) throw error;
      if (!data || data.length === 0) continue;
      // Rows first: a leftover object is invisible, a row pointing at nothing is a broken download.
      const { error: deleteError } = await serviceClient.from(table).delete().in("id", data.map((d) => d.id));
      if (deleteError) throw deleteError;
      await serviceClient.storage.from(bucket).remove(data.map((d) => String(d.storage_path)));
      deleted += data.length;
    }
  } catch (error) {
    console.error("recycle bin sweep", error);
  }
  return deleted;
}
