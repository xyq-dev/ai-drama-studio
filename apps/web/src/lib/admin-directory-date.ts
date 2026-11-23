export function formatShanghai(iso: string | null, style: "full" | "short"): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const clock = `${pick("hour")}:${pick("minute")}`;
  return style === "short" ? `${pick("month")}-${pick("day")} ${clock}` : `${pick("year")}-${pick("month")}-${pick("day")} ${clock}`;
}
