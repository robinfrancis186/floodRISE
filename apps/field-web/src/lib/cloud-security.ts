export const FIREBASE_APP_CHECK_HEADER = "X-Firebase-AppCheck";
export const AUTHORIZATION_HEADER = "Authorization";

export type CloudTokenResult =
  | string
  | { token: string }
  | null
  | undefined;

export type CloudTokenProvider = {
  getToken(forceRefresh?: boolean): Promise<CloudTokenResult> | CloudTokenResult;
};

export type AppCheckTokenResult = CloudTokenResult;
/**
 * Deployment bootstrap may adapt Firebase's `getToken(appCheck, forceRefresh)`
 * to this interface. The returned token is used for one request and is never
 * written to browser storage or retained by this module.
 */
export type AppCheckTokenProvider = CloudTokenProvider;

export type BearerTokenProvider = CloudTokenProvider;

export type CloudSecurityConfiguration = {
  appCheck?: AppCheckTokenProvider;
  /**
   * Production identity bootstrap may adapt `getIdToken(user, forceRefresh)`.
   * When present, demo identity headers are removed and this token is sent as
   * an Authorization bearer credential.
   */
  bearer?: BearerTokenProvider;
  /**
   * Cloud security defaults to the page origin. A deployment using a dedicated
   * API domain must explicitly allow-list that HTTPS origin. This prevents a
   * backend-provided signed upload URL from receiving either token.
   */
  allowedOrigins?: readonly string[];
  /**
   * Keeps the installed offline shell from crossing an API boundary before a
   * new in-memory identity and App Check session has been established.
   */
  blockApiRequests?: boolean;
};

type ActiveConfiguration = {
  appCheck?: AppCheckTokenProvider;
  bearer?: BearerTokenProvider;
  allowedOrigins: ReadonlySet<string>;
  blockApiRequests: boolean;
};

let activeConfiguration: ActiveConfiguration | null = null;

function normalizedOrigin(value: string): string | null {
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

function requestOrigin(input: RequestInfo | URL): string | null {
  const value = typeof Request !== "undefined" && input instanceof Request
    ? input.url
    : input.toString();
  return normalizedOrigin(value);
}

function normalizedToken(result: CloudTokenResult): string | null {
  const value = typeof result === "string" ? result : result?.token;
  if (typeof value !== "string") return null;
  const token = value.trim();
  // Header controls are invalid in HTTP field values and could allow header
  // injection. The size ceiling also prevents an accidental unbounded value.
  if (!token || token.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(token)) return null;
  return token;
}

async function tokenFrom(
  provider: CloudTokenProvider,
  forceRefresh: boolean,
): Promise<string | null> {
  try {
    return normalizedToken(await provider.getToken(forceRefresh));
  } catch {
    // Provider diagnostics can include credentials or debug-token material.
    // The API response remains the only caller-visible authorization result.
    return null;
  }
}

function requestMethod(input: RequestInfo | URL, init: RequestInit): string {
  if (init.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method.toUpperCase();
  }
  return "GET";
}

function canRetryWithFreshToken(
  input: RequestInfo | URL,
  init: RequestInit,
  headers: Headers,
): boolean {
  const method = requestMethod(input, init);
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  return headers.has("Idempotency-Key");
}

function eligibleForCloudSecurity(
  input: RequestInfo | URL,
  configuration: ActiveConfiguration,
): boolean {
  const origin = requestOrigin(input);
  return origin !== null && configuration.allowedOrigins.has(origin);
}

/**
 * Installs in-memory App Check and identity providers. The disposer only removes the
 * configuration it installed, so a late cleanup cannot clear a newer
 * deployment configuration.
 */
export function configureCloudSecurity(
  configuration: CloudSecurityConfiguration | null,
): () => void {
  if (!configuration) {
    activeConfiguration = null;
    return () => undefined;
  }

  const pageOrigin = normalizedOrigin(window.location.origin);
  const configuredOrigins = (configuration.allowedOrigins ?? [])
    .map(normalizedOrigin)
    .filter((origin): origin is string => origin !== null);
  const installed: ActiveConfiguration = {
    appCheck: configuration.appCheck,
    bearer: configuration.bearer,
    blockApiRequests: configuration.blockApiRequests === true,
    allowedOrigins: new Set([
      ...(pageOrigin ? [pageOrigin] : []),
      ...configuredOrigins,
    ]),
  };
  activeConfiguration = installed;

  return () => {
    if (activeConfiguration === installed) activeConfiguration = null;
  };
}

/**
 * Fetch with optional Firebase App Check and bearer protection.
 *
 * The original RequestInit is preserved, including credentials, idempotency
 * headers, bodies, and abort signals. A rejected token is refreshed once only
 * for read-only requests or writes already protected by Idempotency-Key.
 */
export async function cloudFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const configuration = activeConfiguration;
  const headers = new Headers(init.headers);
  let headersChanged = headers.has(FIREBASE_APP_CHECK_HEADER);
  // Only the configured provider may supply this security-sensitive header.
  headers.delete(FIREBASE_APP_CHECK_HEADER);

  if (configuration?.bearer) {
    if (headers.has(AUTHORIZATION_HEADER)) headersChanged = true;
    headers.delete(AUTHORIZATION_HEADER);
    const demoHeaders: string[] = [];
    headers.forEach((_value, name) => {
      if (name.toLowerCase().startsWith("x-demo-")) demoHeaders.push(name);
    });
    for (const name of demoHeaders) headers.delete(name);
    headersChanged ||= demoHeaders.length > 0;
  }

  if (configuration?.blockApiRequests) {
    throw new TypeError(
      "Live network access is paused until identity and device verification are ready.",
    );
  }

  if (!configuration || !eligibleForCloudSecurity(input, configuration)) {
    return fetch(input, headersChanged ? { ...init, headers } : init);
  }

  const [appCheckToken, bearerToken] = await Promise.all([
    configuration.appCheck ? tokenFrom(configuration.appCheck, false) : null,
    configuration.bearer ? tokenFrom(configuration.bearer, false) : null,
  ]);
  if (configuration.appCheck && !appCheckToken) {
    throw new TypeError(
      "Device verification is unavailable. The live request was not started.",
    );
  }
  if (configuration.bearer && !bearerToken) {
    throw new TypeError(
      "Identity verification is unavailable. The live request was not started.",
    );
  }
  if (appCheckToken) headers.set(FIREBASE_APP_CHECK_HEADER, appCheckToken);
  if (bearerToken) headers.set(AUTHORIZATION_HEADER, `Bearer ${bearerToken}`);

  const response = await fetch(input, { ...init, headers });
  if (
    (response.status !== 401 && response.status !== 403)
    || !canRetryWithFreshToken(input, init, headers)
  ) {
    return response;
  }

  const [refreshedAppCheckToken, refreshedBearerToken] = await Promise.all([
    configuration.appCheck ? tokenFrom(configuration.appCheck, true) : null,
    configuration.bearer ? tokenFrom(configuration.bearer, true) : null,
  ]);
  // Never replay a rejected request with a partial credential set. The
  // original response remains authoritative when either refresh fails.
  if (
    (configuration.appCheck && !refreshedAppCheckToken)
    || (configuration.bearer && !refreshedBearerToken)
  ) {
    return response;
  }
  const appCheckChanged = Boolean(
    refreshedAppCheckToken && refreshedAppCheckToken !== appCheckToken,
  );
  const bearerChanged = Boolean(
    refreshedBearerToken && refreshedBearerToken !== bearerToken,
  );
  if (!appCheckChanged && !bearerChanged) return response;

  const retryHeaders = new Headers(headers);
  if (refreshedAppCheckToken) {
    retryHeaders.set(FIREBASE_APP_CHECK_HEADER, refreshedAppCheckToken);
  }
  if (refreshedBearerToken) {
    retryHeaders.set(AUTHORIZATION_HEADER, `Bearer ${refreshedBearerToken}`);
  }
  void response.body?.cancel().catch(() => undefined);
  return fetch(input, { ...init, headers: retryHeaders });
}
