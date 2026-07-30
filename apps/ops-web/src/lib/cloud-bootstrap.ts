import {
  bootstrapFirebaseCloudSecurity,
  type ClientCloudEnvironment,
  type FirebaseCloudBootstrapResult,
  type FirebaseCloudSdk,
} from "@floodrise/cloud-auth";
import { configureCloudSecurity } from "./cloud-security";

export type OperationsCloudBootstrapResult = FirebaseCloudBootstrapResult & {
  dispose: () => void;
};

export async function bootstrapOperationsCloudSecurity(
  environment: ClientCloudEnvironment = import.meta.env,
  sdk?: FirebaseCloudSdk,
  bootstrapTimeoutMs?: number,
): Promise<OperationsCloudBootstrapResult> {
  configureCloudSecurity(null);
  const apiRoot = typeof environment.VITE_API_ROOT === "string"
    ? environment.VITE_API_ROOT.replace(/\/$/u, "")
    : "/api/v1";
  const result = await bootstrapFirebaseCloudSecurity({
    appName: "floodrise-operations",
    apiBase: apiRoot,
    apiConfigKey: "VITE_API_ROOT",
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
