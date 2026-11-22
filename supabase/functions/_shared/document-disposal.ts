// Disposal at the end of retention. No database here, so the tests run this
// file.
//
// Approving a file stamps the day it may first be deleted. Once that day has
// come the file is due: someone who manages documents reviews it and either
// destroys it, with a reason that is kept for good, or keeps it longer.

export const MAX_DISPOSAL_REASON = 500;

interface Kept {
  onHold: boolean;
  /** The first day it may be deleted; null when it was never retained. */
  retainUntil: string | null;
}

/**
 * Why a file can't be disposed of today, or null when it can. `versions` is
 * every version of it, since they all go together.
 */
export function disposalRefusal(
  file: Kept & { archived: boolean; isLatest: boolean },
  versions: readonly Kept[],
  today: string,
): string | null {
  if (file.archived) return "This file has been removed. Delete it from the Recycle Bin instead.";
  if (!file.isLatest) return "Dispose of the latest version; the older ones go with it.";
  if (!file.retainUntil) return "This file has no retention period, so there is nothing to dispose of. Remove it instead.";
  if ([file, ...versions].some((v) => v.onHold)) return "This file, or a version of it, is on hold and can't be disposed of.";
  const latest = [file, ...versions].map((v) => v.retainUntil ?? "").sort().pop() ?? "";
  if (latest > today) return `This file is retained until ${latest} and can't be disposed of before then.`;
  return null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Why a file's retention can't be moved to this day, or null when it can. */
export function extensionRefusal(file: { archived: boolean; retainUntil: string | null }, next: unknown, today: string): string | null {
  if (file.archived) return "This file has been removed.";
  if (!file.retainUntil) return "This file has no retention period to extend.";
  if (typeof next !== "string" || !ISO_DATE.test(next) || Number.isNaN(Date.parse(`${next}T00:00:00Z`))) return "Pick the day to keep it until.";
  if (next <= today) return "Keep it until a day after today.";
  if (next <= file.retainUntil) return "Retention can only be made longer.";
  return null;
}
