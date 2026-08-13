export function formatStatusDuration(seconds: number): string {
  if (seconds < 60) {
    return "less than a minute";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  }
  return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, "0")}h`;
}
