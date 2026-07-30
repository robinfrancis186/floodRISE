import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FirebaseCloudSdk } from "@floodrise/cloud-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureCloudSecurity } from "./lib/cloud-security";
import {
  startOperationsApplication,
  type OperationsApplicationStart,
} from "./startup";

const auth = { currentUser: true };
const providers: Array<{ providerId: string; scopes: readonly string[] }> = [];
const firebaseSdk: FirebaseCloudSdk = {
  application: vi.fn((_configuration: unknown, name: string) => ({ name })),
  memoryOnlyAuth: vi.fn(() => auth),
  completeRedirect: vi.fn().mockResolvedValue(undefined),
  authStateReady: vi.fn().mockResolvedValue(undefined),
  hasCurrentUser: vi.fn(() => auth.currentUser),
  createOidcProvider: vi.fn((providerId, scopes) => {
    const provider = { providerId, scopes };
    providers.push(provider);
    return provider;
  }),
  signInWithRedirect: vi.fn().mockResolvedValue(undefined),
  initializeAppCheck: vi.fn(() => ({ app: "operations" })),
  getAppCheckToken: vi.fn().mockResolvedValue("ops.app-check.token"),
  getIdToken: vi.fn().mockResolvedValue("staff.identity.token"),
};

vi.mock("@floodrise/map", () => ({
  FloodMap: ({ ariaLabel }: { ariaLabel?: string }) => (
    <div aria-label={ariaLabel}>Kerala operations map</div>
  ),
}));

const PRODUCTION_ENVIRONMENT = {
  VITE_DEMO_MODE: "false",
  VITE_API_ROOT: "/api/v1",
  VITE_FIREBASE_API_KEY: "public-firebase-api-key",
  VITE_FIREBASE_AUTH_DOMAIN: "floodrise-ops.firebaseapp.com",
  VITE_FIREBASE_PROJECT_ID: "floodrise-ops-prod",
  VITE_FIREBASE_APP_ID: "1:123456789:web:operations",
  VITE_FIREBASE_APP_CHECK_SITE_KEY: "recaptcha-enterprise-site-key",
  VITE_FIREBASE_AUTH_PROVIDER_ID: "oidc.floodrise-staff",
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

let started: OperationsApplicationStart | null = null;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
  auth.currentUser = true;
  providers.length = 0;
  for (const mock of [
    firebaseSdk.application,
    firebaseSdk.memoryOnlyAuth,
    firebaseSdk.completeRedirect,
    firebaseSdk.authStateReady,
    firebaseSdk.hasCurrentUser,
    firebaseSdk.createOidcProvider,
    firebaseSdk.signInWithRedirect,
    firebaseSdk.initializeAppCheck,
    firebaseSdk.getAppCheckToken,
    firebaseSdk.getIdToken,
  ]) {
    vi.mocked(mock).mockClear();
  }
  vi.mocked(firebaseSdk.getAppCheckToken).mockResolvedValue("ops.app-check.token");
  vi.mocked(firebaseSdk.getIdToken).mockResolvedValue("staff.identity.token");
  vi.mocked(firebaseSdk.signInWithRedirect).mockResolvedValue(undefined);
  vi.mocked(firebaseSdk.completeRedirect).mockResolvedValue(undefined);
  vi.mocked(firebaseSdk.authStateReady).mockResolvedValue(undefined);
});

afterEach(async () => {
  if (started) {
    await act(async () => started?.stop());
    started = null;
  }
  configureCloudSecurity(null);
  cleanup();
  vi.unstubAllGlobals();
});

describe("Operations runtime cloud bootstrap", () => {
  it("protects both initial API reads and the SSE handshake before they leave the app", async () => {
    let bootstrapRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/me")) {
        return jsonResponse({
          user_id: "authority-staff-17",
          roles: ["auditor", "verifier"],
          authenticated: true,
        });
      }
      if (url.endsWith("/incidents")) {
        return jsonResponse({ items: [{
          id: "inc-live-authority-17",
          name: "District flood incident 17",
          status: "ACTIVE",
          scenario_time: "2026-07-30T11:40:00.000Z",
        }] });
      }
      if (url.includes("/incidents/inc-live-authority-17/bootstrap")) {
        bootstrapRequests += 1;
        return jsonResponse({
          scenario_clock: "2026-07-30T11:40:00.000Z",
          incident: {
            id: "inc-live-authority-17",
            name: "District flood incident 17",
            status: "ACTIVE",
            scenario_time: "2026-07-30T11:40:00.000Z",
          },
          signals: [],
          reports: [],
          approvals: [],
          shelters: [],
          sources: [],
          routes: [],
        });
      }
      if (url.includes("/events?incident_id=")) {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    started = await startOperationsApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
    );
    expect(started.status).toBe("ready");
    expect(firebaseSdk.memoryOnlyAuth).toHaveBeenCalledWith(expect.anything());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/auth/me");
    expect(await screen.findByLabelText("Authenticated operational role: Verifier")).toBeVisible();
    expect(screen.queryByLabelText("Active role")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/events?incident_id="))).toBe(true);
    });
    for (const [input, init] of fetchMock.mock.calls) {
      const url = String(input);
      if (!url.startsWith("/api/v1")) continue;
      const headers = new Headers(init?.headers as HeadersInit);
      expect(headers.get("X-Firebase-AppCheck")).toBe("ops.app-check.token");
      expect(headers.get("Authorization")).toBe("Bearer staff.identity.token");
      expect(headers.has("X-Demo-Role")).toBe(false);
      expect(headers.has("X-Demo-User")).toBe(false);
    }
    expect(firebaseSdk.getAppCheckToken).toHaveBeenCalled();
    expect(firebaseSdk.getIdToken).toHaveBeenCalled();

    const user = userEvent.setup();
    for (const destination of [
      "FloodSignal",
      "Incidents",
      "Evacuation",
      "Shelters",
      "Resilience Audit",
      "Source Health",
      "Audit Log",
      "Live Map",
    ]) {
      await user.click(screen.getByRole("button", { name: destination }));
    }
    expect(document.body).not.toHaveTextContent("DEMO DATA");
    expect(document.body).not.toHaveTextContent("Ernakulam");
    expect(document.body).not.toHaveTextContent("Periyar River");
    expect(document.body).not.toHaveTextContent("3,142");
    expect(screen.queryByText("Kerala operations map")).not.toBeInTheDocument();
    expect(screen.getByText("No current FloodSignal cluster")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(bootstrapRequests).toBe(2));
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes("/demo/"))).toBe(true);
  });

  it("renders no operations consumer when production configuration is incomplete", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    started = await startOperationsApplication(document.getElementById("root")!, {
      VITE_DEMO_MODE: "false",
    });

    expect(started.status).toBe("blocked");
    expect(await screen.findByRole("heading", {
      name: "Operations access is paused",
    })).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry verification" })).toBeEnabled();
    expect(document.body).not.toHaveTextContent("VITE_");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(firebaseSdk.application).not.toHaveBeenCalled();
  });

  it("holds API and SSE creation behind the authority OIDC sign-in", async () => {
    auth.currentUser = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    started = await startOperationsApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
    );

    expect(started.status).toBe("sign_in_required");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", {
      name: "Continue with staff sign-in",
    }));
    await waitFor(() => expect(firebaseSdk.signInWithRedirect).toHaveBeenCalledTimes(1));
    expect(providers[0]).toMatchObject({
      providerId: "oidc.floodrise-staff",
      scopes: ["email", "profile"],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(firebaseSdk.initializeAppCheck).not.toHaveBeenCalled();
  });

  it("renders an immediate accessible status, bounds identity startup, and can retry", async () => {
    vi.mocked(firebaseSdk.authStateReady).mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/me")) {
        return jsonResponse({
          user_id: "authority-commander-1",
          roles: ["incident_commander"],
          authenticated: true,
        });
      }
      if (url.endsWith("/incidents")) {
        return jsonResponse({ items: [{ id: "inc-demo-kerala-flood-2023" }] });
      }
      if (url.includes("/incidents/inc-demo-kerala-flood-2023/bootstrap")) {
        return jsonResponse({
          scenario_clock: "2023-12-04T14:10:00.000Z",
          signals: [],
          reports: [],
          approvals: [],
          shelters: [],
          sources: [],
          routes: [],
        });
      }
      if (url.includes("/events?incident_id=")) {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    let startupPromise!: Promise<OperationsApplicationStart>;
    act(() => {
      startupPromise = startOperationsApplication(
        document.getElementById("root")!,
        PRODUCTION_ENVIRONMENT,
        firebaseSdk,
        { bootstrapTimeoutMs: 20 },
      );
    });
    expect(await screen.findByRole("status", {
      name: "Verifying operations access",
    })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();

    started = await startupPromise;
    expect(started.status).toBe("blocked");
    expect(await screen.findByRole("heading", {
      name: "Operations access is paused",
    })).toBeVisible();
    expect(document.body).not.toHaveTextContent("VITE_");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry verification" }));
    expect(await screen.findByRole("heading", { name: "Live Operations" })).toBeVisible();
    expect(started.status).toBe("ready");
  });

  it("fails closed when the authenticated profile cannot be loaded", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/me")) {
        return new Response(null, { status: 401 });
      }
      throw new Error(`No operational request expected after profile failure: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    started = await startOperationsApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
    );

    expect(started.status).toBe("blocked");
    expect(await screen.findByRole("heading", {
      name: "Operations access is paused",
    })).toBeVisible();
    expect(document.body).not.toHaveTextContent("DEMO DATA");
    expect(fetchMock.mock.calls.every(([input]) => String(input).endsWith("/auth/me"))).toBe(true);
  });

  it("does not substitute deterministic data when the live incident request is rejected", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/me")) {
        return jsonResponse({
          user_id: "authority-auditor-4",
          roles: ["auditor"],
          authenticated: true,
        });
      }
      if (url.endsWith("/incidents")) {
        return new Response(null, { status: 401 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    started = await startOperationsApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
    );

    expect(started.status).toBe("ready");
    expect(await screen.findByRole("heading", {
      name: "Authoritative operations unavailable",
    })).toBeVisible();
    expect(screen.getByText(/No demo data is displayed/u)).toBeVisible();
    expect(document.body).not.toHaveTextContent("DEMO DATA");
    expect(screen.queryByText("Kerala operations map")).not.toBeInTheDocument();
  });
});
