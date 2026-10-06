import { InMemoryWebStorage, UserManager, WebStorageStateStore, type User } from "oidc-client-ts";

declare global {
  interface ImportMetaEnv {
    readonly VITE_DEMO_MODE?: string;
    readonly VITE_OIDC_AUTHORITY?: string;
    readonly VITE_OIDC_CLIENT_ID?: string;
    readonly VITE_OIDC_SCOPE?: string;
    readonly VITE_API_ROOT?: string;
    readonly VITE_API_BASE_URL?: string;
    BASE_URL: string;
  }
  interface ImportMeta { readonly env: ImportMetaEnv }
}

export const authenticationRequired = import.meta.env.VITE_DEMO_MODE === "false";
let manager: UserManager | undefined;
let initialization: Promise<User | null> | undefined;

function userManager() {
  if (manager) return manager;
  const authority = import.meta.env.VITE_OIDC_AUTHORITY;
  const clientId = import.meta.env.VITE_OIDC_CLIENT_ID;
  if (!authority || !clientId) throw new Error("The identity provider is not configured. Contact the deployment administrator.");
  const url = new URL(authority);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("The identity provider must use HTTPS.");
  }
  const redirectUri = new URL(import.meta.env.BASE_URL, window.location.origin).href;
  manager = new UserManager({
    authority, client_id: clientId, redirect_uri: redirectUri,
    post_logout_redirect_uri: redirectUri, response_type: "code",
    scope: import.meta.env.VITE_OIDC_SCOPE ?? "openid profile",
    automaticSilentRenew: false, loadUserInfo: false,
    // Tokens stay in memory. Only the short-lived PKCE transaction uses session storage.
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
  });
  return manager;
}

export function initializeSession(): Promise<User | null> {
  initialization ??= (async () => {
    const auth = userManager();
    const params = new URLSearchParams(window.location.search);
    if (params.has("state") && (params.has("code") || params.has("error"))) {
      try {
        const user = await auth.signinRedirectCallback();
        const path = typeof user.state === "string" ? user.state : import.meta.env.BASE_URL;
        const destination = new URL(path, window.location.origin);
        window.history.replaceState({}, "", destination.origin === window.location.origin ? destination.pathname : import.meta.env.BASE_URL);
        return user;
      } finally {
        // Remove authorization codes from the address bar even on a rejected callback.
        if (new URLSearchParams(window.location.search).has("state")) {
          window.history.replaceState({}, "", window.location.pathname);
        }
      }
    }
    return auth.getUser();
  })();
  return initialization;
}

export async function authenticationHeaders(): Promise<Record<string, string>> {
  if (!authenticationRequired) return {};
  const user = await userManager().getUser();
  if (!user?.access_token || user.expired !== false) throw new Error("Your session has expired. Sign in again before continuing.");
  return { Authorization: `Bearer ${user.access_token}` };
}

export async function signIn() {
  await userManager().signinRedirect({ state: window.location.pathname, max_age: 300 });
}

export async function signOut() {
  const auth = userManager();
  const user = await auth.getUser();
  await auth.removeUser();
  await auth.signoutRedirect({ id_token_hint: user?.id_token });
}

export function onSessionExpired(handler: () => void) {
  const events = userManager().events;
  events.addAccessTokenExpired(handler);
  events.addUserUnloaded(handler);
  return () => { events.removeAccessTokenExpired(handler); events.removeUserUnloaded(handler); };
}

export async function sessionUserId(): Promise<string | null> {
  if (!authenticationRequired) return null;
  return (await userManager().getUser())?.profile.sub ?? null;
}
