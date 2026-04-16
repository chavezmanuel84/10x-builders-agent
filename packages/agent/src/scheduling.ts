import { CronExpressionParser } from "cron-parser";

export function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
}

export function getNextCronRunAt(
  expression: string,
  timezone: string,
  fromDate: Date = new Date()
): Date {
  const trimmedExpression = expression.trim();
  const cronFieldCount = trimmedExpression.split(/\s+/).filter(Boolean).length;
  const normalizedExpression =
    cronFieldCount === 5 ? `0 ${trimmedExpression}` : trimmedExpression;
  if (!trimmedExpression) {
    throw new Error("Cron expression is required");
  }
  assertValidTimezone(timezone);
  try {
    const interval = CronExpressionParser.parse(normalizedExpression, {
      currentDate: fromDate,
      tz: timezone,
      strict: true,
    });
    return interval.next().toDate();
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid expression";
    throw new Error(`Invalid cron expression: ${message}`);
  }
}
