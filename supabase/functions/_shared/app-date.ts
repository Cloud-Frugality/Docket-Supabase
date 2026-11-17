// The organisation's calendar day, in its time zone (organisations.time_zone).
// Using the UTC clock made dates wrong just after midnight. public.app_today()
// in the database reads the same setting. Import-free so the tests run this
// exact file.

/** The zone before anyone sets one. */
export const APP_TIME_ZONE = "Africa/Johannesburg";

/** Today in the given zone, as yyyy-mm-dd. */
export function appToday(now: Date = new Date(), timeZone: string = APP_TIME_ZONE): string {
  // en-CA formats as yyyy-mm-dd; the parts are read rather than trusting that.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The day before appToday, as yyyy-mm-dd. */
export function appYesterday(now: Date = new Date(), timeZone: string = APP_TIME_ZONE): string {
  const today = Date.parse(`${appToday(now, timeZone)}T00:00:00Z`);
  return new Date(today - 86_400_000).toISOString().slice(0, 10);
}
