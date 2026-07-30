import type { Plugin } from "vite";

export type FirebaseSourceState = {
  commit: string;
  dirty: boolean;
  treeSha256: string;
};

export type FirebasePublicConfigDigests = {
  apiKeySha256: string;
  appCheckSiteKeySha256: string;
  authProviderIdSha256: string;
};

export type FirebaseBuildMetadata = {
  format: 1;
  firebaseSdkVersion: "12.16.0";
  application: "ops" | "field";
  environment: "demo" | "live" | "local";
  apiBase: "/api/v1";
  firebase: {
    projectId: string | null;
    appId: string | null;
    authDomain: string | null;
    publicConfigDigests: FirebasePublicConfigDigests | null;
  };
  source: FirebaseSourceState;
};

export const FIREBASE_BUILD_METADATA_FILE: "floodrise-build-metadata.json";
export const FIREBASE_BUILD_METADATA_FORMAT: 1;
export const FIREBASE_WEB_SDK_VERSION: "12.16.0";

export function readFirebaseSourceState(repositoryRoot: string): FirebaseSourceState;
export function normalizeFirebaseProjectId(value: unknown): string;
export function normalizeFirebaseAppId(value: unknown): string;
export function normalizeFirebaseApiKey(value: unknown): string;
export function normalizeFirebaseAppCheckSiteKey(value: unknown): string;
export function normalizeFirebaseAuthProviderId(value: unknown): string;
export function normalizeFirebaseAuthDomain(value: unknown): string;
export function normalizeFirebaseApiBase(value: unknown): "/api/v1";
export function createFirebasePublicConfigDigests(options: {
  apiKey: unknown;
  appCheckSiteKey: unknown;
  authProviderId: unknown;
}): FirebasePublicConfigDigests;
export function validateFirebasePublicConfigDigests(
  value: unknown,
): FirebasePublicConfigDigests;
export function createFirebaseBuildMetadata(options: {
  application: "ops" | "field";
  apiConfigKey: "VITE_API_ROOT" | "VITE_API_BASE_URL";
  environment: Record<string, string | undefined>;
  source: FirebaseSourceState;
}): FirebaseBuildMetadata;
export function validateFirebaseBuildMetadata(
  value: unknown,
  expectedApplication: "ops" | "field",
): FirebaseBuildMetadata;
export function firebaseBuildMetadataPlugin(options: {
  application: "ops" | "field";
  apiConfigKey: "VITE_API_ROOT" | "VITE_API_BASE_URL";
  environment: Record<string, string | undefined>;
  repositoryRoot: string;
}): Plugin;
