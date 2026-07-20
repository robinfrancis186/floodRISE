import { clearDemoFieldData } from "./db";
import { clearForcedOfflineMode } from "./network";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "/api/v1";
const LAST_SYNC_KEY = "floodrise.field.last-sync";

type DemoHealth = {
  demo_mode?: boolean;
  data_label?: string;
  environment?: string;
};

export type DemoDeviceResetResult = {
  queuedDrafts: number;
  receipts: number;
  environment: string;
};

/**
 * Clear this origin's Field PWA demo evidence after the server proves it is a
 * demo runtime. The explicit UI action that calls this function is important:
 * merely opening a reset URL must never erase browser storage.
 */
export async function clearThisDemoDevice(): Promise<DemoDeviceResetResult> {
  const response = await fetch(`${API_BASE}/health`, {
    cache: "no-store",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`Demo mode could not be verified (${response.status}). No local data was removed.`);
  }

  const health = (await response.json()) as DemoHealth;
  if (health.demo_mode !== true || health.data_label !== "DEMO DATA") {
    throw new Error("The connected API is not an isolated demo runtime. No local data was removed.");
  }

  const cleared = await clearDemoFieldData();
  localStorage.removeItem(LAST_SYNC_KEY);
  clearForcedOfflineMode();
  return {
    ...cleared,
    environment: health.environment ?? "demo"
  };
}
