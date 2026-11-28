// Server-side input validation. The client's zod schemas and maxLength are
// advisory, since any non-browser caller skips them, so ids and free text are
// checked here too.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// True for a well-formed UUID string. Stops a bad id reaching Postgres, whose
// cast error would leak internals.
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

/**
 * The most an hourly rate may be. A slipped digit (19000 for 1900) would flow
 * into every margin and chart with nothing looking broken. R100 000 is about
 * ten times the dearest real rate and still catches that.
 */
export const MAX_RATE = 100_000;

// Max lengths for free text, enforced server-side: a short cap for names, a
// roomier one for everything else.
export const MAX_NAME = 200;
export const MAX_TEXT = 1000;

// True when a trimmed string exceeds `max` characters.
export function overMaxLength(value: string, max: number): boolean {
  return value.length > max;
}

// The expiry date to store when saving a user, given the one the form sent.
//
// Reactivating an account whose expiry has passed clears the date. Otherwise
// the hourly disable_expired_users cron bans it again straight away; the form
// sends the lapsed date back unchanged, so it's dropped here. Suspending
// leaves the date alone, since it records why the account was disabled.
//
// yyyy-MM-dd strings sort chronologically; `today` is the caller's UTC date,
// matching the cron's current_date. Strictly `<`: an expiry of today is still
// live, because the cron only disables once the date is past.
export function expiryForSave(
  suspended: boolean,
  requested: string | null,
  today: string,
): string | null {
  if (suspended || requested === null) return requested;
  return requested < today ? null : requested;
}

// A yyyy-MM-dd string that is a real date. Date.parse rolls "2026-02-30" over
// to March, so only a value that formats back to itself counts.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDateString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!ISO_DATE_RE.test(trimmed)) return false;
  const parsed = Date.parse(`${trimmed}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === trimmed;
}

// Case-insensitive match to a fixed vocabulary: "on hold" comes back as
// "On Hold", anything outside the list as null.
export function normalizeToVocabulary<T extends string>(value: unknown, vocabulary: readonly T[]): T | null {
  if (typeof value !== "string") return null;
  const needle = value.trim().toLowerCase();
  return vocabulary.find((entry) => entry.toLowerCase() === needle) ?? null;
}

// Exact membership in a fixed vocabulary; null for anything outside it.
export function pickFrom<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return (allowed as readonly string[]).includes(trimmed) ? (trimmed as T[number]) : null;
}

// An email address, loosely: something@something.tld with no whitespace. GoTrue
// does the real check when an address becomes a login. Mirrored in
// the Windows app.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

// A two-letter ISO country code (letters only), case-insensitive.
export function isCountryCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z]{2}$/.test(value.trim());
}

// A person's name: starts with a letter (any script), then letters, combining
// marks, spaces, hyphens, apostrophes, periods. Digits and symbols are typos
// or worse ("J0hn", "Alice;DROP"). Mirrored client-side; keep the two in step.
const PERSON_NAME_RE = /^[\p{L}][\p{L}\p{M}\s.'’-]*$/u;
export function isPersonName(value: string): boolean {
  return PERSON_NAME_RE.test(value.trim());
}

// A display name for a client or engagement: free-form, since company names
// carry digits and punctuation ("NTT (Pty) Ltd", "Phase 2"), but it needs at
// least one letter or digit and no control characters.
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
export function isDisplayName(value: string): boolean {
  const trimmed = value.trim();
  return /[\p{L}\p{N}]/u.test(trimmed) && !hasControlChars(trimmed);
}

// Postgres unique violation. supabase-js gives us the SQLSTATE, so a name clash
// can name what clashed instead of returning a generic 500.
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}
