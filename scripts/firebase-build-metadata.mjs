import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const FIREBASE_BUILD_METADATA_FILE = "floodrise-build-metadata.json";
export const FIREBASE_BUILD_METADATA_FORMAT = 1;
export const FIREBASE_WEB_SDK_VERSION = "12.16.0";

const APPLICATIONS = new Set(["ops", "field"]);
const DEPLOYMENT_ENVIRONMENTS = new Set(["demo", "live", "local"]);
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const APP_ID_PATTERN = /^1:[0-9]+:web:[0-9a-f]+$/u;
const API_KEY_PATTERN = /^AIza[0-9A-Za-z_-]{35}$/u;
const APP_CHECK_SITE_KEY_PATTERN = /^[0-9A-Za-z_-]{20,200}$/u;
const AUTH_PROVIDER_ID_PATTERN = /^oidc\.[0-9A-Za-z._-]{1,100}$/u;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PUBLIC_CONFIG_DIGEST_FIELDS = [
  "apiKeySha256",
  "appCheckSiteKeySha256",
  "authProviderIdSha256",
];

function textValue(environment, key) {
  const value = environment[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requireText(environment, key) {
  const value = textValue(environment, key);
  if (!value) throw new Error(`${key} is required for a deployable Firebase build.`);
  return value;
}

export function normalizeFirebaseProjectId(value) {
  if (typeof value !== "string" || !PROJECT_ID_PATTERN.test(value)) {
    throw new Error("Firebase project ID must be an exact lowercase project identifier.");
  }
  return value;
}

export function normalizeFirebaseAppId(value) {
  if (typeof value !== "string" || !APP_ID_PATTERN.test(value)) {
    throw new Error("Firebase app ID must match 1:PROJECT_NUMBER:web:HEX_APP_HASH.");
  }
  return value;
}

export function normalizeFirebaseApiKey(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!API_KEY_PATTERN.test(normalized)) {
    throw new Error("Firebase Web API key must be one exact AIza-formatted public key.");
  }
  return normalized;
}

export function normalizeFirebaseAppCheckSiteKey(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!APP_CHECK_SITE_KEY_PATTERN.test(normalized)) {
    throw new Error("Firebase App Check site key must be one exact public site key.");
  }
  return normalized;
}

export function normalizeFirebaseAuthProviderId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!AUTH_PROVIDER_ID_PATTERN.test(normalized)) {
    throw new Error("Firebase Auth provider ID must be one exact oidc.* provider ID.");
  }
  return normalized;
}

function publicConfigDigest(kind, value) {
  return createHash("sha256")
    .update(`floodrise-firebase-${kind}/v1\0`)
    .update(value)
    .digest("hex");
}

export function createFirebasePublicConfigDigests({
  apiKey,
  appCheckSiteKey,
  authProviderId,
}) {
  return {
    apiKeySha256: publicConfigDigest(
      "api-key",
      normalizeFirebaseApiKey(apiKey),
    ),
    appCheckSiteKeySha256: publicConfigDigest(
      "app-check-site-key",
      normalizeFirebaseAppCheckSiteKey(appCheckSiteKey),
    ),
    authProviderIdSha256: publicConfigDigest(
      "auth-provider-id",
      normalizeFirebaseAuthProviderId(authProviderId),
    ),
  };
}

export function validateFirebasePublicConfigDigests(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",")
      !== [...PUBLIC_CONFIG_DIGEST_FIELDS].sort().join(",")
  ) {
    throw new Error("Firebase public configuration digest receipt is invalid.");
  }
  for (const field of PUBLIC_CONFIG_DIGEST_FIELDS) {
    if (!SHA256_PATTERN.test(value[field])) {
      throw new Error(`Firebase public configuration ${field} is invalid.`);
    }
  }
  return Object.fromEntries(
    PUBLIC_CONFIG_DIGEST_FIELDS.map((field) => [field, value[field]]),
  );
}

export function normalizeFirebaseAuthDomain(value) {
  if (
    typeof value !== "string"
    || value !== value.toLowerCase()
    || value.includes("*")
    || value.includes("/")
    || value.includes(":")
    || value.length > 253
  ) {
    throw new Error("Firebase auth domain must be one exact lowercase HTTPS hostname.");
  }
  const labels = value.split(".");
  if (labels.length < 2 || labels.some((label) => !DNS_LABEL_PATTERN.test(label))) {
    throw new Error("Firebase auth domain must be one exact lowercase HTTPS hostname.");
  }
  return value;
}

export function normalizeFirebaseApiBase(value) {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : "/api/v1";
  if (
    !candidate.startsWith("/")
    || candidate.startsWith("//")
    || candidate.includes("?")
    || candidate.includes("#")
    || candidate.includes("\\")
  ) {
    throw new Error("Firebase Hosting API base must be a same-origin absolute path.");
  }
  const normalized = candidate.replace(/\/+$/u, "") || "/";
  if (normalized !== "/api/v1") {
    throw new Error("Firebase Hosting API base must be exactly /api/v1.");
  }
  return normalized;
}

function runGit(repositoryRoot, args, encoding = undefined) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited with status ${result.status ?? "unknown"}.`);
  }
  return result.stdout;
}

export function readFirebaseSourceState(repositoryRoot) {
  const commit = String(
    runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD"], "utf8"),
  ).trim();
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error("Unable to resolve an immutable source commit for the Firebase build.");
  }

  const status = runGit(
    repositoryRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  );
  const listed = runGit(
    repositoryRoot,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  );
  const paths = listed
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  const digest = createHash("sha256");
  digest.update("floodrise-source-tree/v1\0");

  for (const path of paths) {
    digest.update(path);
    digest.update("\0");
    const absolutePath = join(repositoryRoot, path);
    let metadata;
    try {
      metadata = lstatSync(absolutePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      digest.update("missing\0");
      continue;
    }

    if (metadata.isSymbolicLink()) {
      digest.update("symlink\0");
      digest.update(readlinkSync(absolutePath));
    } else if (metadata.isFile()) {
      digest.update(metadata.mode & 0o111 ? "executable\0" : "file\0");
      digest.update(readFileSync(absolutePath));
    } else {
      throw new Error(`Firebase source input is not a regular file: ${path}`);
    }
    digest.update("\0");
  }

  return {
    commit,
    dirty: status.length > 0,
    treeSha256: digest.digest("hex"),
  };
}

export function createFirebaseBuildMetadata({
  application,
  apiConfigKey,
  environment,
  source,
}) {
  if (!APPLICATIONS.has(application)) {
    throw new Error("Firebase build application must be exactly ops or field.");
  }
  const deploymentEnvironment = textValue(environment, "VITE_DEPLOYMENT_ENVIRONMENT") ?? "local";
  if (!DEPLOYMENT_ENVIRONMENTS.has(deploymentEnvironment)) {
    throw new Error("VITE_DEPLOYMENT_ENVIRONMENT must be exactly demo or live when supplied.");
  }

  const demoMode = textValue(environment, "VITE_DEMO_MODE");
  if (deploymentEnvironment === "demo" && demoMode !== "true") {
    throw new Error("A demo Firebase artifact requires VITE_DEMO_MODE=true.");
  }
  if (deploymentEnvironment === "live" && demoMode !== "false") {
    throw new Error("A live Firebase artifact requires VITE_DEMO_MODE=false.");
  }
  if (
    deploymentEnvironment === "local"
    && (
      demoMode === "false"
      || Object.keys(environment).some(
        (key) => key.startsWith("VITE_FIREBASE_") && textValue(environment, key),
      )
    )
  ) {
    throw new Error(
      "Cloud-configured builds require an explicit VITE_DEPLOYMENT_ENVIRONMENT.",
    );
  }

  const apiBase = normalizeFirebaseApiBase(textValue(environment, apiConfigKey));
  const firebase = deploymentEnvironment === "local"
    ? {
        projectId: null,
        appId: null,
        authDomain: null,
        publicConfigDigests: null,
      }
    : {
        projectId: normalizeFirebaseProjectId(
          requireText(environment, "VITE_FIREBASE_PROJECT_ID"),
        ),
        appId: normalizeFirebaseAppId(
          requireText(environment, "VITE_FIREBASE_APP_ID"),
        ),
        authDomain: normalizeFirebaseAuthDomain(
          requireText(environment, "VITE_FIREBASE_AUTH_DOMAIN"),
        ),
        publicConfigDigests: createFirebasePublicConfigDigests({
          apiKey: requireText(environment, "VITE_FIREBASE_API_KEY"),
          appCheckSiteKey: requireText(
            environment,
            "VITE_FIREBASE_APP_CHECK_SITE_KEY",
          ),
          authProviderId: requireText(
            environment,
            "VITE_FIREBASE_AUTH_PROVIDER_ID",
          ),
        }),
      };

  return validateFirebaseBuildMetadata(
    {
      format: FIREBASE_BUILD_METADATA_FORMAT,
      firebaseSdkVersion: FIREBASE_WEB_SDK_VERSION,
      application,
      environment: deploymentEnvironment,
      apiBase,
      firebase,
      source,
    },
    application,
  );
}

export function validateFirebaseBuildMetadata(value, expectedApplication) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Firebase build metadata must be a JSON object.");
  }
  if (value.format !== FIREBASE_BUILD_METADATA_FORMAT) {
    throw new Error("Firebase build metadata format is unsupported.");
  }
  if (value.firebaseSdkVersion !== FIREBASE_WEB_SDK_VERSION) {
    throw new Error("Firebase build metadata SDK version is unsupported.");
  }
  if (!APPLICATIONS.has(value.application) || value.application !== expectedApplication) {
    throw new Error(`Firebase build metadata does not belong to ${expectedApplication}.`);
  }
  if (!DEPLOYMENT_ENVIRONMENTS.has(value.environment)) {
    throw new Error("Firebase build metadata environment is invalid.");
  }

  const apiBase = normalizeFirebaseApiBase(value.apiBase);
  let firebase;
  if (value.environment === "local") {
    if (
      !value.firebase
      || value.firebase.projectId !== null
      || value.firebase.appId !== null
      || value.firebase.authDomain !== null
      || value.firebase.publicConfigDigests !== null
    ) {
      throw new Error("Local Firebase build metadata cannot contain a deployable target.");
    }
    firebase = {
      projectId: null,
      appId: null,
      authDomain: null,
      publicConfigDigests: null,
    };
  } else {
    firebase = {
      projectId: normalizeFirebaseProjectId(value.firebase?.projectId),
      appId: normalizeFirebaseAppId(value.firebase?.appId),
      authDomain: normalizeFirebaseAuthDomain(value.firebase?.authDomain),
      publicConfigDigests: validateFirebasePublicConfigDigests(
        value.firebase?.publicConfigDigests,
      ),
    };
  }

  if (
    !value.source
    || typeof value.source.dirty !== "boolean"
    || !COMMIT_PATTERN.test(value.source.commit)
    || !SHA256_PATTERN.test(value.source.treeSha256)
  ) {
    throw new Error("Firebase build metadata source identity is invalid.");
  }

  return {
    format: FIREBASE_BUILD_METADATA_FORMAT,
    firebaseSdkVersion: FIREBASE_WEB_SDK_VERSION,
    application: value.application,
    environment: value.environment,
    apiBase,
    firebase,
    source: {
      commit: value.source.commit,
      dirty: value.source.dirty,
      treeSha256: value.source.treeSha256,
    },
  };
}

export function firebaseBuildMetadataPlugin({
  application,
  apiConfigKey,
  environment,
  repositoryRoot,
}) {
  return {
    name: `floodrise-firebase-build-metadata-${application}`,
    apply: "build",
    generateBundle() {
      const metadata = createFirebaseBuildMetadata({
        application,
        apiConfigKey,
        environment,
        source: readFirebaseSourceState(repositoryRoot),
      });
      this.emitFile({
        type: "asset",
        fileName: FIREBASE_BUILD_METADATA_FILE,
        source: `${JSON.stringify(metadata, null, 2)}\n`,
      });
    },
  };
}
