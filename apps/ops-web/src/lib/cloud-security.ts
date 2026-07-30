export const FIREBASE_APP_CHECK_HEADER = "X-Firebase-AppCheck";
export const AUTHORIZATION_HEADER = "Authorization";

export class CloudCredentialUnavailableError extends Error {
  constructor() {
    super("Verified cloud credentials are unavailable. No live request was sent.");
    this.name = "CloudCredentialUnavailableError";
  }
}

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
  appCheck: AppCheckTokenProvider;
  /**
   * Production identity bootstrap may adapt `getIdToken(user, forceRefresh)`.
   * Demo identity headers are removed and this token is sent as an
   * Authorization bearer credential.
   */
  bearer: BearerTokenProvider;
  /**
   * Cloud security defaults to the page origin. A deployment using a dedicated
   * API domain must explicitly allow-list that HTTPS origin.
   */
  allowedOrigins?: readonly string[];
};

type ActiveConfiguration = {
  appCheck: AppCheckTokenProvider;
  bearer: BearerTokenProvider;
  allowedOrigins: ReadonlySet<string>;
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
    // Do not expose provider errors: they can contain credentials or debug
    // token material. The API remains the authorization source of truth.
    return null;
  }
}

function requireConfiguredTokens(
  appCheckToken: string | null,
  bearerToken: string | null,
) {
  if (
    !appCheckToken
    || !bearerToken
  ) {
    throw new CloudCredentialUnavailableError();
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
 * Preserves the caller's credentials, idempotency header, body, and abort
 * signal. Token refresh is attempted once only for safe reads or
 * idempotency-protected writes.
 */
export async function cloudFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const configuration = activeConfiguration;
  const headers = new Headers(init.headers);
  let headersChanged = headers.has(FIREBASE_APP_CHECK_HEADER);
  headers.delete(FIREBASE_APP_CHECK_HEADER);

  if (configuration) {
    if (headers.has(AUTHORIZATION_HEADER)) headersChanged = true;
    headers.delete(AUTHORIZATION_HEADER);
    const demoHeaders: string[] = [];
    headers.forEach((_value, name) => {
      if (name.toLowerCase().startsWith("x-demo-")) demoHeaders.push(name);
    });
    for (const name of demoHeaders) headers.delete(name);
    headersChanged ||= demoHeaders.length > 0;
  }

  if (!configuration || !eligibleForCloudSecurity(input, configuration)) {
    return fetch(input, headersChanged ? { ...init, headers } : init);
  }

  const [appCheckToken, bearerToken] = await Promise.all([
    tokenFrom(configuration.appCheck, false),
    tokenFrom(configuration.bearer, false),
  ]);
  requireConfiguredTokens(appCheckToken, bearerToken);
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
    tokenFrom(configuration.appCheck, true),
    tokenFrom(configuration.bearer, true),
  ]);
  try {
    requireConfiguredTokens(
      refreshedAppCheckToken,
      refreshedBearerToken,
    );
  } catch (error) {
    void response.body?.cancel().catch(() => undefined);
    throw error;
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
