import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import {
  createFirebaseBuildMetadata,
  createFirebasePublicConfigDigests,
  readFirebaseSourceState,
  validateFirebaseBuildMetadata,
} from "../../scripts/firebase-build-metadata.mjs";

const source = {
  commit: "a".repeat(40),
  dirty: false,
  treeSha256: "b".repeat(64),
};
const apiKey = `AIza${"A".repeat(35)}`;
const appCheckSiteKey = `6L${"B".repeat(38)}`;
const authProviderId = "oidc.floodrise-staff";
const publicConfigDigests = createFirebasePublicConfigDigests({
  apiKey,
  appCheckSiteKey,
  authProviderId,
});

test("per-app build metadata captures the exact deployable Vite inputs", () => {
  const metadata = createFirebaseBuildMetadata({
    application: "ops",
    apiConfigKey: "VITE_API_ROOT",
    environment: {
      VITE_DEPLOYMENT_ENVIRONMENT: "live",
      VITE_DEMO_MODE: "false",
      VITE_API_ROOT: "/api/v1/",
      VITE_FIREBASE_PROJECT_ID: "floodrise-production-5305",
      VITE_FIREBASE_APP_ID: "1:123456789012:web:aaaaaaaaaaaaaaaaaaaaaa",
      VITE_FIREBASE_AUTH_DOMAIN: "auth.floodrise.gov.in",
      VITE_FIREBASE_API_KEY: apiKey,
      VITE_FIREBASE_APP_CHECK_SITE_KEY: appCheckSiteKey,
      VITE_FIREBASE_AUTH_PROVIDER_ID: authProviderId,
    },
    source,
  });

  assert.deepEqual(metadata, {
    format: 1,
    firebaseSdkVersion: "12.16.0",
    application: "ops",
    environment: "live",
    apiBase: "/api/v1",
    firebase: {
      projectId: "floodrise-production-5305",
      appId: "1:123456789012:web:aaaaaaaaaaaaaaaaaaaaaa",
      authDomain: "auth.floodrise.gov.in",
      publicConfigDigests,
    },
    source,
  });
});

test("ordinary local builds remain non-deployable and credential-free", () => {
  assert.deepEqual(
    createFirebaseBuildMetadata({
      application: "field",
      apiConfigKey: "VITE_API_BASE_URL",
      environment: {},
      source: { ...source, dirty: true },
    }),
    {
      format: 1,
      firebaseSdkVersion: "12.16.0",
      application: "field",
      environment: "local",
      apiBase: "/api/v1",
      firebase: {
        projectId: null,
        appId: null,
        authDomain: null,
        publicConfigDigests: null,
      },
      source: { ...source, dirty: true },
    },
  );
});

test("build metadata fails closed on ambiguous mode or malformed project inputs", () => {
  const base = {
    VITE_DEPLOYMENT_ENVIRONMENT: "live",
    VITE_DEMO_MODE: "false",
    VITE_FIREBASE_PROJECT_ID: "floodrise-production-5305",
    VITE_FIREBASE_APP_ID: "1:123456789012:web:aaaaaaaaaaaaaaaaaaaaaa",
    VITE_FIREBASE_AUTH_DOMAIN: "auth.floodrise.gov.in",
    VITE_FIREBASE_API_KEY: apiKey,
    VITE_FIREBASE_APP_CHECK_SITE_KEY: appCheckSiteKey,
    VITE_FIREBASE_AUTH_PROVIDER_ID: authProviderId,
  };
  assert.throws(
    () =>
      createFirebaseBuildMetadata({
        application: "ops",
        apiConfigKey: "VITE_API_ROOT",
        environment: { ...base, VITE_DEMO_MODE: "true" },
        source,
      }),
    /requires VITE_DEMO_MODE=false/,
  );
  assert.throws(
    () =>
      createFirebaseBuildMetadata({
        application: "ops",
        apiConfigKey: "VITE_API_ROOT",
        environment: {
          VITE_DEMO_MODE: "false",
          VITE_FIREBASE_PROJECT_ID: "floodrise-production-5305",
        },
        source,
      }),
    /explicit VITE_DEPLOYMENT_ENVIRONMENT/,
  );
  assert.throws(
    () =>
      createFirebaseBuildMetadata({
        application: "ops",
        apiConfigKey: "VITE_API_ROOT",
        environment: {
          ...base,
          VITE_FIREBASE_AUTH_DOMAIN: "*.firebaseapp.com",
        },
        source,
      }),
    /exact lowercase HTTPS hostname/,
  );
  assert.throws(
    () =>
      createFirebaseBuildMetadata({
        application: "ops",
        apiConfigKey: "VITE_API_ROOT",
        environment: {
          ...base,
          VITE_API_ROOT: "https://api.example.invalid/api/v1",
        },
        source,
      }),
    /same-origin absolute path/,
  );
  for (const [key, message] of [
    ["VITE_FIREBASE_API_KEY", /is required for a deployable Firebase build/],
    [
      "VITE_FIREBASE_APP_CHECK_SITE_KEY",
      /is required for a deployable Firebase build/,
    ],
    [
      "VITE_FIREBASE_AUTH_PROVIDER_ID",
      /is required for a deployable Firebase build/,
    ],
  ]) {
    const incomplete = { ...base };
    delete incomplete[key];
    assert.throws(
      () =>
        createFirebaseBuildMetadata({
          application: "ops",
          apiConfigKey: "VITE_API_ROOT",
          environment: incomplete,
          source,
        }),
      message,
    );
  }
  assert.throws(
    () =>
      createFirebaseBuildMetadata({
        application: "ops",
        apiConfigKey: "VITE_API_ROOT",
        environment: {
          ...base,
          VITE_FIREBASE_AUTH_PROVIDER_ID: "saml.staff",
        },
        source,
      }),
    /exact oidc\.\* provider ID/,
  );
});

test("metadata parser rejects app substitution and invalid source receipts", () => {
  const value = {
    format: 1,
    firebaseSdkVersion: "12.16.0",
    application: "ops",
    environment: "live",
    apiBase: "/api/v1",
    firebase: {
      projectId: "floodrise-production-5305",
      appId: "1:123456789012:web:aaaaaaaaaaaaaaaaaaaaaa",
      authDomain: "auth.floodrise.gov.in",
      publicConfigDigests,
    },
    source,
  };
  assert.throws(
    () => validateFirebaseBuildMetadata(value, "field"),
    /does not belong to field/,
  );
  assert.throws(
    () =>
      validateFirebaseBuildMetadata(
        {
          ...value,
          source: { ...source, treeSha256: "not-a-digest" },
        },
        "ops",
      ),
    /source identity is invalid/,
  );
  assert.throws(
    () =>
      validateFirebaseBuildMetadata(
        {
          ...value,
          firebase: {
            ...value.firebase,
            publicConfigDigests: {
              ...publicConfigDigests,
              apiKeySha256: "not-a-digest",
            },
          },
        },
        "ops",
      ),
    /apiKeySha256 is invalid/,
  );
});

test("public configuration receipts are domain-separated and mutation-sensitive", () => {
  assert.equal(
    publicConfigDigests.apiKeySha256,
    createHash("sha256")
      .update("floodrise-firebase-api-key/v1\0")
      .update(apiKey)
      .digest("hex"),
  );
  assert.equal(
    publicConfigDigests.appCheckSiteKeySha256,
    createHash("sha256")
      .update("floodrise-firebase-app-check-site-key/v1\0")
      .update(appCheckSiteKey)
      .digest("hex"),
  );
  assert.equal(
    publicConfigDigests.authProviderIdSha256,
    createHash("sha256")
      .update("floodrise-firebase-auth-provider-id/v1\0")
      .update(authProviderId)
      .digest("hex"),
  );

  for (const [field, mutation] of [
    ["apiKeySha256", { apiKey: `${apiKey.slice(0, -1)}Z` }],
    [
      "appCheckSiteKeySha256",
      { appCheckSiteKey: `${appCheckSiteKey.slice(0, -1)}Z` },
    ],
    ["authProviderIdSha256", { authProviderId: `${authProviderId}-other` }],
  ]) {
    const mutated = createFirebasePublicConfigDigests({
      apiKey,
      appCheckSiteKey,
      authProviderId,
      ...mutation,
    });
    assert.notEqual(mutated[field], publicConfigDigests[field]);
  }
});

test("source-state receipt is deterministic for an unchanged working tree", () => {
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const first = readFirebaseSourceState(repositoryRoot);
  const second = readFirebaseSourceState(repositoryRoot);
  assert.match(first.commit, /^[0-9a-f]{40}$/u);
  assert.match(first.treeSha256, /^[0-9a-f]{64}$/u);
  assert.equal(typeof first.dirty, "boolean");
  assert.deepEqual(second, first);
});
