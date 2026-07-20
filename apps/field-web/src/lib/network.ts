const FORCED_OFFLINE_KEY = "floodrise.field.force-offline";
export const NETWORK_MODE_CHANGED_EVENT = "floodrise:network-mode-changed";

export function isForcedOfflineMode() {
  if (typeof window === "undefined") return false;
  const requested = new URLSearchParams(window.location.search).get("offline");
  if (requested === "1") sessionStorage.setItem(FORCED_OFFLINE_KEY, "1");
  if (requested === "0") sessionStorage.removeItem(FORCED_OFFLINE_KEY);
  return sessionStorage.getItem(FORCED_OFFLINE_KEY) === "1";
}

export function clearForcedOfflineMode() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(FORCED_OFFLINE_KEY);
  window.dispatchEvent(new CustomEvent(NETWORK_MODE_CHANGED_EVENT));
}
