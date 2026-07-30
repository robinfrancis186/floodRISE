import {
  getApp,
  getApps,
  initializeApp,
  type FirebaseApp,
  type FirebaseOptions,
} from "firebase/app";
import {
  getToken as getAppCheckToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "firebase/app-check";
import {
  getAuth,
  getIdToken,
  getRedirectResult,
  inMemoryPersistence,
  initializeAuth,
  OAuthProvider,
  signInWithRedirect,
  type Auth,
} from "firebase/auth";

export type ClientCloudEnvironment = Readonly<
  Record<string, string | boolean | undefined>
>;

export type CloudTokenProvider = {
  getToken(forceRefresh?: boolean): Promise<string | { token: string } | null>;
};

export type FirebaseCloudSdk = {
  application: (options: FirebaseOptions, appName: string) => unknown;
  memoryOnlyAuth: (app: unknown) => unknown;
  completeRedirect: (auth: unknown) => Promise<void>;
  authStateReady: (auth: unknown) => Promise<void>;
  hasCurrentUser: (auth: unknown) => boolean;
  createOidcProvider: (
    providerId: string,
    scopes: readonly string[],
  ) => unknown;
  signInWithRedirect: (auth: unknown, provider: unknown) => Promise<void>;
  initializeAppCheck: (app: unknown, siteKey: string) => unknown;
  getAppCheckToken: (
    appCheck: unknown,
    forceRefresh: boolean,
  ) => Promise<string>;
  getIdToken: (auth: unknown, forceRefresh: boolean) => Promise<string | null>;
};

export type FirebaseCloudBootstrapResult =
  | { status: "demo" }
  | {
      status: "sign_in_required";
      signIn: () => Promise<void>;
    }
  | {
      status: "ready";
      appCheck: CloudTokenProvider;
      bearer: CloudTokenProvider;
      allowedOrigins: readonly string[];
    };

export class CloudBootstrapError extends Error {
  constructor(
    readonly code:
      | "INVALID_CONFIGURATION"
      | "IDENTITY_UNAVAILABLE"
      | "APP_CHECK_UNAVAILABLE",
    message: string,
    readonly missingKeys: readonly string[] = [],
  ) {
    super(message);
    this.name = "CloudBootstrapError";
  }
}

export type FirebaseCloudBootstrapOptions = {
  appName: string;
  apiBase: string;
  apiConfigKey: "VITE_API_BASE_URL" | "VITE_API_ROOT";
  environment?: ClientCloudEnvironment;
  sdk?: FirebaseCloudSdk;
  /**
   * Bounds redirect completion and initial identity restoration. Firebase
   * does not expose an AbortSignal for these operations, so the application
   * fails closed once this deadline is reached.
   */
  bootstrapTimeoutMs?: number;
};

export type FirebaseCloudDeploymentValidationOptions = Pick<
  FirebaseCloudBootstrapOptions,
  "apiBase" | "apiConfigKey" | "environment"
>;

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10_000;
const MAX_BOOTSTRAP_TIMEOUT_MS = 30_000;

const REQUIRED_CONFIGURATION = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_APP_ID",
  "VITE_FIREBASE_APP_CHECK_SITE_KEY",
  "VITE_FIREBASE_AUTH_PROVIDER_ID",
] as const;

function textValue(
  environment: ClientCloudEnvironment,
  key: string,
): string | undefined {
  const raw = environment[key];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (
    !value
    || value.length > 1_024
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return undefined;
  }
  return value;
}

function isProductionRequested(environment: ClientCloudEnvironment): boolean {
  const rawDemoMode = environment.VITE_DEMO_MODE;
  const demoMode = typeof rawDemoMode === "string" ? rawDemoMode.trim() : undefined;
  if (
    rawDemoMode !== undefined
    && (demoMode !== "true" && demoMode !== "false")
  ) {
    throw new CloudBootstrapError(
      "INVALID_CONFIGURATION",
      "Live access is unavailable because the deployment mode is invalid.",
      ["VITE_DEMO_MODE"],
    );
  }
  if (demoMode === "true") return false;
  if (demoMode === "false") return true;
  return REQUIRED_CONFIGURATION.some((key) => environment[key] !== undefined);
}

function requiredConfiguration(environment: ClientCloudEnvironment) {
  const missingKeys = REQUIRED_CONFIGURATION.filter(
    (key) => textValue(environment, key) === undefined,
  );
  if (missingKeys.length) {
    throw new CloudBootstrapError(
      "INVALID_CONFIGURATION",
      "Live access is unavailable because required cloud configuration is incomplete.",
      missingKeys,
    );
  }

  const providerId = textValue(
    environment,
    "VITE_FIREBASE_AUTH_PROVIDER_ID",
  )!;
  if (!/^oidc\.[A-Za-z0-9._-]{1,100}$/u.test(providerId)) {
    throw new CloudBootstrapError(
      "INVALID_CONFIGURATION",
      "Live access is unavailable because the configured identity provider is not an OIDC provider.",
      ["VITE_FIREBASE_AUTH_PROVIDER_ID"],
    );
  }

  return {
    firebase: {
      apiKey: textValue(environment, "VITE_FIREBASE_API_KEY")!,
      authDomain: textValue(environment, "VITE_FIREBASE_AUTH_DOMAIN")!,
      projectId: textValue(environment, "VITE_FIREBASE_PROJECT_ID")!,
      appId: textValue(environment, "VITE_FIREBASE_APP_ID")!,
      messagingSenderId: textValue(
        environment,
        "VITE_FIREBASE_MESSAGING_SENDER_ID",
      ),
    } satisfies FirebaseOptions,
    appCheckSiteKey: textValue(
      environment,
      "VITE_FIREBASE_APP_CHECK_SITE_KEY",
    )!,
    providerId,
    scopes: (textValue(environment, "VITE_FIREBASE_AUTH_SCOPES") ?? "email,profile")
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => /^[A-Za-z0-9._:/-]{1,80}$/u.test(scope))
      .slice(0, 10),
  };
}

function application(options: FirebaseOptions, appName: string): FirebaseApp {
  return getApps().some((candidate) => candidate.name === appName)
    ? getApp(appName)
    : initializeApp(options, appName);
}

function applicationAuth(app: FirebaseApp): Auth {
  try {
    return initializeAuth(app, { persistence: inMemoryPersistence });
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "auth/already-initialized"
    ) {
      return getAuth(app);
    }
    throw error;
  }
}

const defaultFirebaseSdk: FirebaseCloudSdk = {
  application,
  memoryOnlyAuth: (app) => applicationAuth(app as FirebaseApp),
  completeRedirect: async (auth) => {
    await getRedirectResult(auth as Auth);
  },
  authStateReady: (auth) => (auth as Auth).authStateReady(),
  hasCurrentUser: (auth) => Boolean((auth as Auth).currentUser),
  createOidcProvider: (providerId, scopes) => {
    const provider = new OAuthProvider(providerId);
    for (const scope of scopes) provider.addScope(scope);
    return provider;
  },
  signInWithRedirect: async (auth, provider) => {
    await signInWithRedirect(auth as Auth, provider as OAuthProvider);
  },
  initializeAppCheck: (app, siteKey) => initializeAppCheck(app as FirebaseApp, {
    provider: new ReCaptchaEnterpriseProvider(siteKey),
    isTokenAutoRefreshEnabled: false,
  }),
  getAppCheckToken: async (appCheck, forceRefresh) => (
    await getAppCheckToken(
      appCheck as ReturnType<typeof initializeAppCheck>,
      forceRefresh,
    )
  ).token,
  getIdToken: (auth, forceRefresh) => {
    const user = (auth as Auth).currentUser;
    return user ? getIdToken(user, forceRefresh) : Promise.resolve(null);
  },
};

function allowedOrigins(
  apiBase: string,
  apiConfigKey: "VITE_API_BASE_URL" | "VITE_API_ROOT",
): readonly string[] {
  let apiUrl: URL;
  try {
    apiUrl = new URL(apiBase, window.location.href);
  } catch {
    throw new CloudBootstrapError(
      "INVALID_CONFIGURATION",
      "Live access is unavailable because the API address is invalid.",
      [apiConfigKey],
    );
  }
  if (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") {
    throw new CloudBootstrapError(
      "INVALID_CONFIGURATION",
      "Live access is unavailable because the API address is invalid.",
      [apiConfigKey],
    );
  }
  if (window.location.protocol === "https:" && apiUrl.protocol !== "https:") {
    throw new CloudBootstrapError(
      "INVALID_CONFIGURATION",
      "Live access is unavailable because the API address would downgrade HTTPS.",
      [apiConfigKey],
    );
  }
  return apiUrl.origin === window.location.origin ? [] : [apiUrl.origin];
}

/**
 * Synchronously classifies and validates a browser deployment without
 * initializing Firebase. Field can therefore open its offline-only shell only
 * for a complete, valid live deployment—not for malformed configuration.
 */
export function validateFirebaseCloudDeployment({
  apiBase,
  apiConfigKey,
  environment = {},
}: FirebaseCloudDeploymentValidationOptions): "demo" | "live" {
  if (!isProductionRequested(environment)) return "demo";
  requiredConfiguration(environment);
  allowedOrigins(apiBase, apiConfigKey);
  return "live";
}

class BootstrapDeadlineError extends Error {
  constructor() {
    super("Cloud bootstrap deadline exceeded");
    this.name = "BootstrapDeadlineError";
  }
}

function boundedTimeout(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  }
  return Math.min(MAX_BOOTSTRAP_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

async function withinDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new BootstrapDeadlineError()), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function validInitialToken(value: string | null): value is string {
  if (typeof value !== "string") return false;
  const token = value.trim();
  return Boolean(
    token
    && token.length <= 8_192
    && !/[\u0000-\u001f\u007f]/u.test(token),
  );
}

/**
 * Initializes Firebase App Check and Identity Platform before an application
 * may create API consumers. Firebase Auth is explicitly memory-only: neither
 * ID tokens nor refresh credentials are written to durable browser storage.
 */
export async function bootstrapFirebaseCloudSecurity({
  appName,
  apiBase,
  apiConfigKey,
  environment = {},
  sdk = defaultFirebaseSdk,
  bootstrapTimeoutMs,
}: FirebaseCloudBootstrapOptions): Promise<FirebaseCloudBootstrapResult> {
  const deployment = validateFirebaseCloudDeployment({
    apiBase,
    apiConfigKey,
    environment,
  });
  if (deployment === "demo") return { status: "demo" };

  const configuration = requiredConfiguration(environment);
  // Validate the request boundary before any identity work. A malformed or
  // downgraded API address is a deployment fault, not an offline condition.
  const approvedOrigins = allowedOrigins(apiBase, apiConfigKey);
  const app = sdk.application(configuration.firebase, appName);
  let auth: unknown;
  try {
    auth = sdk.memoryOnlyAuth(app);
    await withinDeadline((async () => {
      await sdk.completeRedirect(auth);
      await sdk.authStateReady(auth);
    })(), boundedTimeout(bootstrapTimeoutMs));
  } catch (error) {
    if (error instanceof BootstrapDeadlineError) {
      throw new CloudBootstrapError(
        "IDENTITY_UNAVAILABLE",
        "Identity verification did not respond in time. No live request was started.",
      );
    }
    throw new CloudBootstrapError(
      "IDENTITY_UNAVAILABLE",
      "The identity service could not be initialized. No live request was started.",
    );
  }

  if (!sdk.hasCurrentUser(auth)) {
    return {
      status: "sign_in_required",
      signIn: async () => {
        const provider = sdk.createOidcProvider(
          configuration.providerId,
          configuration.scopes,
        );
        try {
          await withinDeadline(
            sdk.signInWithRedirect(auth, provider),
            boundedTimeout(bootstrapTimeoutMs),
          );
        } catch (error) {
          throw new CloudBootstrapError(
            "IDENTITY_UNAVAILABLE",
            error instanceof BootstrapDeadlineError
              ? "Sign-in did not respond in time. No live request was sent."
              : "Sign-in could not be started. No live request was sent.",
          );
        }
      },
    };
  }

  let appCheck: unknown;
  try {
    appCheck = sdk.initializeAppCheck(app, configuration.appCheckSiteKey);
  } catch {
    throw new CloudBootstrapError(
      "APP_CHECK_UNAVAILABLE",
      "Device verification could not be initialized. No live request was started.",
    );
  }

  let initialAppCheckToken: string | null;
  let initialBearerToken: string | null;
  try {
    [initialAppCheckToken, initialBearerToken] = await withinDeadline(
      Promise.all([
        sdk.getAppCheckToken(appCheck, false),
        sdk.getIdToken(auth, false),
      ]),
      boundedTimeout(bootstrapTimeoutMs),
    );
  } catch (error) {
    throw new CloudBootstrapError(
      "APP_CHECK_UNAVAILABLE",
      error instanceof BootstrapDeadlineError
        ? "Device and identity verification did not respond in time. No live request was started."
        : "Device and identity verification could not be completed. No live request was started.",
    );
  }
  if (!validInitialToken(initialAppCheckToken)) {
    throw new CloudBootstrapError(
      "APP_CHECK_UNAVAILABLE",
      "Device verification could not be completed. No live request was started.",
    );
  }
  if (!validInitialToken(initialBearerToken)) {
    throw new CloudBootstrapError(
      "IDENTITY_UNAVAILABLE",
      "Identity verification could not be completed. No live request was started.",
    );
  }

  return {
    status: "ready",
    appCheck: {
      getToken: (forceRefresh = false) => sdk.getAppCheckToken(
        appCheck,
        forceRefresh,
      ),
    },
    bearer: {
      getToken: (forceRefresh = false) => sdk.getIdToken(auth, forceRefresh),
    },
    allowedOrigins: approvedOrigins,
  };
}
