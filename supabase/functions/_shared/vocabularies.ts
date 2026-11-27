// The app's fixed vocabularies, enforced server-side so a direct API caller
// can't store an unknown value (or hit an enum and get an opaque 500).
// Import-free so the tests run this file. Keep in step with
// src/lib/constants.ts; tests/lib/vocabularies.test.ts fails on drift.

export const INDUSTRIES = [
  "Finance",
  "Healthcare",
  "Insurance",
  "Retail",
  "Telecommunications",
  "Logistics",
  "Technology",
  "Energy",
  "Public Sector",
  "Tourism",
  "Banking",
] as const;

// Clients archive rather than carry a status, and engagement types are rows
// in engagement_types, so neither has a vocabulary here.

// Bug logging (keep in step with src/lib/constants.ts)
export const BUG_LOCATIONS = [
  "Sign In",
  "Navigation / Shell",
  "Client Management",
  "Engagement Management",
  "Documents",
  "Users",
  "Teams",
  "Settings",
  "Other",
] as const;

export const DEFECT_TYPES = [
  "Functionality",
  "Usability",
  "UI / Visual",
  "Performance",
  "Data / Incorrect Values",
  "Security",
  "Compatibility",
  "Other",
] as const;

export const BUG_SEVERITIES = ["Low", "Medium", "High", "Critical"] as const;
export const BROWSERS = ["Chrome", "Edge", "Firefox", "Safari", "Other"] as const;
// Server-side only: no UI changes a bug's status yet, so there's no client
// copy.
export const BUG_STATUSES = ["Open", "In Progress", "Re-test", "Closed"] as const;

// Feature requests (keep in step with src/lib/constants.ts). They share the
// area vocabulary with bugs: feature_request_administration uses
// BUG_LOCATIONS directly.
export const FEATURE_TYPES = [
  "New Feature",
  "Enhancement",
  "Integration",
  "UX Improvement",
  "Reporting",
  "Performance",
  "Other",
] as const;

export const FEATURE_IMPACTS = ["Nice to have", "Would save time", "Blocking me", "Crucial"] as const;

// RBAC matrix, pinned against src/lib/constants.ts by the tests
export const ACCESS_ENTITIES = [
  "Clients",
  "Engagements",
  "Users",
  "Bug Reports",
  "Feature Requests",
  "Users & Access Roles",
  // The Documents page and file rules. Read opens the page (Own: the files you
  // uploaded); Write changes a file's details from it; Delete removes other
  // people's files and restores or erases removed ones.
  "Documents",
] as const;

export const ACCESS_READONLY_ENTITIES = [] as const;

// Entities with no meaningful "my own": a submitted Own is promoted to All
// rather than stored as a scope that would do nothing.
export const ACCESS_NO_OWN_ENTITIES = ["Bug Reports", "Users & Access Roles"] as const;

// A person's role within one team. Not an access role: access roles say what
// you may do, this says whether you run the team. Keep in step with TEAM_ROLES
// in src/lib/constants.ts.
export const TEAM_ROLES = ["member", "team_admin"] as const;

// A team's region and default currency. The database checks the same lists;
// keep in step with src/lib/constants.ts.
export const REGIONS = ["Africa", "Americas", "Asia Pacific", "Europe", "Middle East"] as const;
export const CURRENCIES = ["ZAR", "USD", "GBP", "EUR", "KES", "AED", "AUD"] as const;
/** What a money value shows before the figure. */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  ZAR: "R",
  USD: "$",
  GBP: "£",
  EUR: "€",
  KES: "KSh",
  AED: "AED",
  AUD: "A$",
};

// The organisation's time zone and date format. Keep in step with src/lib/constants.ts.
export const TIME_ZONES = [
  "Africa/Johannesburg", "Africa/Nairobi", "Africa/Lagos", "Africa/Cairo",
  "Europe/London", "Europe/Dublin", "Europe/Amsterdam", "Europe/Berlin", "Europe/Paris",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo",
  "Australia/Perth", "Australia/Sydney", "Pacific/Auckland",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo",
  "UTC",
] as const;
export const DATE_FORMATS = ["dd MMM yyyy", "dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd"] as const;

// Landing pages a role can start on → the entity whose Read gates them
// (you can't land where you can't look). Keep in step with LANDING_PAGES in
// src/lib/constants.ts.
export const LANDING_ENTITY: Record<string, string> = {
  "/documents": "Documents",
  "/users": "Users",
};

/** Exact membership: the client fixes casing before sending, so the server
 *  holds to the real spelling rather than guessing. */
export function inVocabulary(value: unknown, vocabulary: readonly string[]): boolean {
  return typeof value === "string" && vocabulary.includes(value.trim());
}

/** The message for a rejected value. Names the value and the accepted set so
 *  a direct API caller can fix it without reading the source. */
export function vocabularyError(field: string, value: unknown, vocabulary: readonly string[]): string {
  const shown = typeof value === "string" && value.trim() ? `"${value.trim()}"` : "An empty value";
  return `${shown} is not a valid ${field}. Expected one of: ${vocabulary.join(", ")}.`;
}

// Preferences that follow the user.
// Key prefixes the browser may sync to user_preferences: every family in
// PREFERENCE_PREFIXES (src/lib/storage-consent.ts) except the theme (a
// per-machine choice) and the Documents page's filters. Drift-tested against
// src/lib/preference-keys.ts.
export const SYNCED_PREFERENCE_PREFIXES = [
  "stencil-clients-",
  "stencil-engagements-",
] as const;
