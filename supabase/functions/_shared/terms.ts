// The organisation's own words for a client and an engagement. Pure, so the
// tests run this file. Mirrored for the screens in src/lib/terms.ts.

export const TERM_KEYS = ["client", "clients", "engagement", "engagements"] as const;
export type TermKey = (typeof TERM_KEYS)[number];
export type Terms = Record<TermKey, string>;

export const DEFAULT_TERMS: Terms = {
  client: "Client",
  clients: "Clients",
  engagement: "Engagement",
  engagements: "Engagements",
};

export const MAX_TERM = 30;

/** A word to save, or why it can't be: letters and single spaces, kept as typed. */
export function cleanTerm(value: unknown): { value: string } | { error: string } {
  const term = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!term) return { error: "Each word needs at least one letter." };
  if (term.length > MAX_TERM) return { error: `Each word must be ${MAX_TERM} characters or fewer.` };
  if (!/^\p{L}[\p{L} ]*$/u.test(term)) return { error: "Words can only hold letters and spaces." };
  return { value: term };
}
