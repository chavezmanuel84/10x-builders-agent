/**
 * Render a short relative timestamp:
 *   <60s  -> "Justo ahora"
 *   <60m  -> "Hace Nm"
 *   <24h  -> "Hace Nh"
 *   <7d   -> "Hace Nd"
 *   else  -> "dd/MM" or "dd/MM/yy" if the year differs from now.
 */
export function formatRelativeShort(input: string | Date | null | undefined): string {
  if (!input) return "";
  const date = typeof input === "string" ? new Date(input) : input;
  const time = date instanceof Date ? date.getTime() : Number.NaN;
  if (Number.isNaN(time)) return "";

  const now = Date.now();
  const diffMs = now - time;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return "Justo ahora";
  if (diffMs < hour) return `Hace ${Math.floor(diffMs / minute)}m`;
  if (diffMs < day) return `Hace ${Math.floor(diffMs / hour)}h`;
  if (diffMs < 7 * day) return `Hace ${Math.floor(diffMs / day)}d`;

  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  const nowYear = new Date(now).getFullYear();
  if (yyyy === nowYear) return `${dd}/${mm}`;
  return `${dd}/${mm}/${String(yyyy).slice(-2)}`;
}
