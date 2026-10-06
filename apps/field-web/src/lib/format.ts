export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRelativeTime(timestamp: number, now = Date.now()) {
  const difference = timestamp - now;
  const absoluteMinutes = Math.max(0, Math.round(Math.abs(difference) / 60_000));
  if (difference >= 0) {
    if (absoluteMinutes < 60) return `expires in ${absoluteMinutes} min`;
    return `expires in ${Math.ceil(absoluteMinutes / 60)} hr`;
  }
  if (absoluteMinutes < 1) return "just now";
  if (absoluteMinutes < 60) return `${absoluteMinutes} min ago`;
  return `${Math.floor(absoluteMinutes / 60)} hr ago`;
}

export function formatDistance(metres: number) {
  return metres < 1_000 ? `${Math.round(metres / 10) * 10} m` : `${(metres / 1_000).toFixed(1)} km`;
}

export function formatDateTime(value: string | number) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
    timeZoneName: "short"
  }).format(typeof value === "number" ? value : new Date(value));
}
