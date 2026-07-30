import {
  bootstrapFirebaseCloudSecurity,
  type ClientCloudEnvironment,
  type FirebaseCloudBootstrapResult,
  type FirebaseCloudSdk,
  validateFirebaseCloudDeployment,
} from "@floodrise/cloud-auth";
import { configureCloudSecurity } from "./cloud-security";

export type FieldCloudBootstrapResult = FirebaseCloudBootstrapResult & {
  dispose: () => void;
};

function fieldApiBase(environment: ClientCloudEnvironment) {
  return typeof environment.VITE_API_BASE_URL === "string"
    ? environment.VITE_API_BASE_URL.replace(/\/$/u, "")
    : "/api/v1";
}

export function validateFieldCloudDeployment(
  environment: ClientCloudEnvironment = import.meta.env,
) {
  return validateFirebaseCloudDeployment({
    apiBase: fieldApiBase(environment),
    apiConfigKey: "VITE_API_BASE_URL",
    environment,
  });
}

export async function bootstrapFieldCloudSecurity(
  environment: ClientCloudEnvironment = import.meta.env,
  sdk?: FirebaseCloudSdk,
  bootstrapTimeoutMs?: number,
): Promise<FieldCloudBootstrapResult> {
  configureCloudSecurity(null);
  const result = await bootstrapFirebaseCloudSecurity({
    appName: "floodrise-field",
    apiBase: fieldApiBase(environment),
    apiConfigKey: "VITE_API_BASE_URL",
    environment,
    sdk,
    bootstrapTimeoutMs,
  });
  if (result.status !== "ready") {
    return { ...result, dispose: () => configureCloudSecurity(null) };
  }

  const dispose = configureCloudSecurity({
    appCheck: result.appCheck,
    bearer: result.bearer,
    allowedOrigins: result.allowedOrigins,
  });
  return { ...result, dispose };
}

/**
 * Installs a fail-closed request boundary for the offline-only Field shell.
 * IndexedDB drafts and queue reads remain local, while every API caller using
 * cloudFetch is stopped before it reaches window.fetch.
 */
export function lockFieldToOfflineAccess() {
  return configureCloudSecurity({ blockApiRequests: true });
}
