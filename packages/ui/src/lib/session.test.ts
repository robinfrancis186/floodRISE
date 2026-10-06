import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), callback: vi.fn(), redirect: vi.fn() }));
vi.mock("oidc-client-ts", () => ({
  UserManager: class {
    getUser = mocks.getUser;
    signinRedirectCallback = mocks.callback;
    signinRedirect = mocks.redirect;
  },
  InMemoryWebStorage: class {},
  WebStorageStateStore: class {},
}));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); window.history.replaceState({}, "", "/"); });

it("keeps demo requests anonymous and requires an unexpired bearer session for protected requests", async () => {
  vi.stubEnv("VITE_DEMO_MODE", "true");
  let auth = await import("./session");
  expect(await auth.authenticationHeaders()).toEqual({});
  vi.resetModules();
  vi.stubEnv("VITE_DEMO_MODE", "false");
  vi.stubEnv("VITE_OIDC_AUTHORITY", "https://identity.example.in");
  vi.stubEnv("VITE_OIDC_CLIENT_ID", "public-browser-client");
  auth = await import("./session");
  mocks.getUser.mockResolvedValue({ access_token: "test-token", expired: false });
  expect(await auth.authenticationHeaders()).toEqual({ Authorization: "Bearer test-token" });
  mocks.getUser.mockResolvedValue({ access_token: "test-token", expired: true });
  await expect(auth.authenticationHeaders()).rejects.toThrow("session has expired");
});

it("consumes an OIDC callback once and removes codes without accepting an external return URL", async () => {
  vi.stubEnv("VITE_DEMO_MODE", "false");
  vi.stubEnv("VITE_OIDC_AUTHORITY", "https://identity.example.in");
  vi.stubEnv("VITE_OIDC_CLIENT_ID", "public-browser-client");
  window.history.replaceState({}, "", "/?code=test-code&state=test-state");
  mocks.callback.mockResolvedValue({ state: "https://untrusted.example/", profile: { sub: "test-user" } });
  const auth = await import("./session");
  await Promise.all([auth.initializeSession(), auth.initializeSession()]);
  expect(mocks.callback).toHaveBeenCalledTimes(1);
  expect(window.location.pathname).toBe("/");
  expect(window.location.search).toBe("");
});
