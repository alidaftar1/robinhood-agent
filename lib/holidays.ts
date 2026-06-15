// NYSE market holidays — cron should skip these days to avoid wasted runs.
// Update each December for the following year.

const NYSE_HOLIDAYS = new Set([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Day
  "2026-02-16", // Presidents' Day
  "2026-04-03", // Good Friday (Easter April 5)
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day observed (July 4 = Saturday)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
  // 2027
  "2027-01-01", // New Year's Day
  "2027-01-18", // MLK Day
  "2027-02-15", // Presidents' Day
  "2027-03-26", // Good Friday (Easter March 28)
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth observed (June 19 = Saturday)
  "2027-07-05", // Independence Day observed (July 4 = Sunday)
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving
  "2027-12-24", // Christmas observed (Dec 25 = Saturday)
]);

export function isMarketHoliday(date: string): boolean {
  return NYSE_HOLIDAYS.has(date);
}
