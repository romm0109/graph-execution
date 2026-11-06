export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const text = i > 0 && value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${text} ${units[i]}`;
}

export function formatAge(createdAt: string | undefined, now: Date): string {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  if (Number.isNaN(t)) return "?";
  const minutes = Math.max(0, Math.floor((now.getTime() - t) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
