import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FirebaseCloudSdk } from "@floodrise/cloud-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fieldDb, type OfflineReportDraft } from "./lib/db";
import { submitReport } from "./lib/api";
import { configureCloudSecurity } from "./lib/cloud-security";
import {
  LEGACY_FIELD_ALERT_CACHE,
  LEGACY_FIELD_API_CACHE,
} from "./lib/service-worker-cache";
import { startFieldApplication, type FieldApplicationStart } from "./startup";

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
  initializeAppCheck: vi.fn(() => ({ app: "field" })),
  getAppCheckToken: vi.fn().mockResolvedValue("field.app-check.token"),
  getIdToken: vi.fn().mockResolvedValue("reporter.identity.token"),
};

vi.mock("@floodrise/map", () => ({
  FloodMap: ({ ariaLabel }: { ariaLabel?: string }) => (
    <div aria-label={ariaLabel}>Kerala map</div>
  ),
}));

const PRODUCTION_ENVIRONMENT = {
  VITE_DEMO_MODE: "false",
  VITE_API_BASE_URL: "/api/v1",
  VITE_FIREBASE_API_KEY: "public-firebase-api-key",
  VITE_FIREBASE_AUTH_DOMAIN: "floodrise-field.firebaseapp.com",
  VITE_FIREBASE_PROJECT_ID: "floodrise-field-prod",
  VITE_FIREBASE_APP_ID: "1:123456789:web:field",
  VITE_FIREBASE_APP_CHECK_SITE_KEY: "recaptcha-enterprise-site-key",
  VITE_FIREBASE_AUTH_PROVIDER_ID: "oidc.floodrise-authority",
};

function reportDraft(): OfflineReportDraft {
  return {
    client_report_id: "startup-report-client-0001",
    incident_id: "inc-demo-kerala-flood-2023",
    reporter_id: "reporter-field-1",
    device_id: "device-field-1",
    observed_at: "2023-12-04T14:10:00.000Z",
    location: { latitude: 10.1041, longitude: 76.3519, accuracy_m: 12 },
    water_depth: "KNEE",
    road_status: "DIFFICULT",
    infrastructure_issues: ["BLOCKED_DRAIN"],
    place_label: "Aluva–Paravur Road",
  };
}

function reportResponse() {
  return new Response(JSON.stringify({
    report: { id: "report-startup-1" },
    receipt: {
      report_id: "report-startup-1",
      client_report_id: "startup-report-client-0001",
      accepted_at: "2023-12-04T14:10:00.000Z",
      disposition: "ELIGIBLE",
      sync_message: "Report received.",
    },
  }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

function liveBootstrapResponse(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    server_time: "2026-07-30T10:00:00.000Z",
    scenario_clock: "2026-07-30T10:00:00.000Z",
    demo_mode: false,
    data_label: "LIVE",
    incident: {
      id: "inc-live-ernakulam-2026",
      name: "Ernakulam monsoon response",
      status: "ACTIVE",
      area_name: "Ernakulam district",
      is_demo: false,
      is_simulated: false,
      data_label: "LIVE",
    },
    sources: [],
    layers: [],
    signals: [],
    shelters: [],
    alerts: [],
    ...overrides,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

let started: FieldApplicationStart | null = null;

beforeEach(async () => {
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState({}, "", "/");
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  localStorage.clear();
  sessionStorage.clear();
  await Promise.all([
    fieldDb.queue.clear(),
    fieldDb.receipts.clear(),
  ]);
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
  vi.mocked(firebaseSdk.getAppCheckToken).mockResolvedValue("field.app-check.token");
  vi.mocked(firebaseSdk.getIdToken).mockResolvedValue("reporter.identity.token");
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

describe("Field runtime cloud bootstrap", () => {
  it("installs memory-only OIDC and App Check before the real report caller runs", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(liveBootstrapResponse())
      .mockResolvedValueOnce(reportResponse());
    vi.stubGlobal("fetch", fetchMock);
    started = await startFieldApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
    );
    expect(started.status).toBe("ready");
    expect(firebaseSdk.memoryOnlyAuth).toHaveBeenCalledWith(expect.anything());

    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const liveDraft = {
      ...reportDraft(),
      incident_id: "inc-live-ernakulam-2026",
      observed_at: "2026-07-30T10:01:00.000Z",
    };
    await expect(submitReport(liveDraft)).resolves.toMatchObject({
      id: "report-startup-1",
      source: "API",
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/incidents/bootstrap");
    const bootstrapHeaders = new Headers(
      fetchMock.mock.calls[0]?.[1]?.headers as HeadersInit,
    );
    expect(bootstrapHeaders.get("X-Firebase-AppCheck")).toBe("field.app-check.token");
    expect(bootstrapHeaders.get("Authorization")).toBe("Bearer reporter.identity.token");
    expect(bootstrapHeaders.has("X-Demo-Role")).toBe(false);
    expect(bootstrapHeaders.has("X-Demo-User")).toBe(false);
    const headers = new Headers(fetchMock.mock.calls[1]?.[1]?.headers as HeadersInit);
    expect(headers.get("X-Firebase-AppCheck")).toBe("field.app-check.token");
    expect(headers.get("Authorization")).toBe("Bearer reporter.identity.token");
    expect(headers.has("X-Demo-Role")).toBe(false);
    expect(headers.has("X-Demo-User")).toBe(false);
    expect(firebaseSdk.getAppCheckToken).toHaveBeenCalledWith(expect.anything(), false);
    expect(firebaseSdk.getIdToken).toHaveBeenCalledWith(auth, false);
  });

  it("renders no API consumer when production cloud configuration is incomplete", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    started = await startFieldApplication(document.getElementById("root")!, {
      VITE_DEMO_MODE: "false",
    });

    expect(started.status).toBe("blocked");
    expect(await screen.findByRole("heading", { name: "Live access is paused" })).toBeVisible();
    expect(document.body).not.toHaveTextContent("VITE_");
    expect(screen.getByRole("button", { name: "Try secure access again" })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(firebaseSdk.application).not.toHaveBeenCalled();
  });

  it("does not treat an invalid deployment mode as offline-ready", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    started = await startFieldApplication(
      document.getElementById("root")!,
      { ...PRODUCTION_ENVIRONMENT, VITE_DEMO_MODE: "sometimes" },
      firebaseSdk,
    );

    expect(started.status).toBe("blocked");
    expect(await screen.findByRole("heading", { name: "Live access is paused" })).toBeVisible();
    expect(document.body).not.toHaveTextContent("VITE_");
    expect(firebaseSdk.application).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not open the offline shell for incomplete live configuration", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    started = await startFieldApplication(
      document.getElementById("root")!,
      { VITE_DEMO_MODE: "false" },
      firebaseSdk,
    );

    expect(started.status).toBe("blocked");
    expect(await screen.findByRole("heading", { name: "Live access is paused" })).toBeVisible();
    expect(screen.queryByText("Offline draft review is available")).not.toBeInTheDocument();
    expect(firebaseSdk.application).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when historical authenticated cache deletion fails", async () => {
    const fetchMock = vi.fn();
    const deleteCache = vi.fn().mockRejectedValue(new Error("cache storage unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", { delete: deleteCache });

    started = await startFieldApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
    );

    expect(started.status).toBe("blocked");
    expect(await screen.findByRole("heading", { name: "Live access is paused" })).toBeVisible();
    expect(screen.queryByText("Offline draft review is available")).not.toBeInTheDocument();
    expect(firebaseSdk.application).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an authority OIDC sign-in before rendering the application", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    auth.currentUser = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    started = await startFieldApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
    );

    expect(started.status, document.body.textContent ?? "").toBe("sign_in_required");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", {
      name: "Continue with secure sign-in",
    }));
    await waitFor(() => expect(firebaseSdk.signInWithRedirect).toHaveBeenCalledTimes(1));
    expect(providers[0]).toMatchObject({
      providerId: "oidc.floodrise-authority",
      scopes: ["email", "profile"],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(firebaseSdk.initializeAppCheck).not.toHaveBeenCalled();
  });

  it("bounds a stalled sign-in redirect without exposing a live caller", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    auth.currentUser = false;
    vi.mocked(firebaseSdk.signInWithRedirect).mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    started = await startFieldApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
      { bootstrapTimeoutMs: 20 },
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", {
      name: "Continue with secure sign-in",
    }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign-in could not be started",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders an immediate accessible status while identity restoration is pending", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    let completeRedirect: (() => void) | undefined;
    vi.mocked(firebaseSdk.completeRedirect).mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        completeRedirect = resolve;
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(liveBootstrapResponse()));

    const starting = startFieldApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Preparing secure access");
    expect(document.querySelector("main")?.getAttribute("aria-busy")).toBe("true");
    await waitFor(() => expect(completeRedirect).toBeTypeOf("function"));
    completeRedirect?.();
    started = await starting;
    expect(started.status).toBe("ready");
  });

  it("bounds a stalled online identity bootstrap and fails closed with retry", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.mocked(firebaseSdk.completeRedirect).mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    started = await startFieldApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
      { bootstrapTimeoutMs: 20 },
    );

    expect(started.status).toBe("blocked");
    expect(await screen.findByRole("heading", { name: "Live access is paused" })).toBeVisible();
    expect(screen.getByText(/did not respond in time/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Try secure access again" })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preflights both credentials and blocks live rendering when either is absent", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.mocked(firebaseSdk.getIdToken).mockResolvedValueOnce(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    started = await startFieldApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
    );

    expect(started.status).toBe("blocked");
    expect(await screen.findByRole("heading", { name: "Live access is paused" })).toBeVisible();
    expect(screen.getByText(/Identity verification could not be completed/u)).toBeVisible();
    expect(firebaseSdk.getAppCheckToken).toHaveBeenCalledWith(expect.anything(), false);
    expect(firebaseSdk.getIdToken).toHaveBeenCalledWith(auth, false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not become live-ready when the initial App Check token is invalid", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.mocked(firebaseSdk.getAppCheckToken).mockResolvedValueOnce("");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    started = await startFieldApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
    );

    expect(started.status).toBe("blocked");
    expect(await screen.findByText(/Device verification could not be completed/u)).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds the initial credential preflight before exposing live callers", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.mocked(firebaseSdk.getAppCheckToken).mockImplementationOnce(
      () => new Promise<string>(() => undefined),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    started = await startFieldApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
      { bootstrapTimeoutMs: 20 },
    );

    expect(started.status).toBe("blocked");
    expect(await screen.findByText(/did not respond in time/u)).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reopens offline without memory auth and keeps incident-bound live features locked", async () => {
    auth.currentUser = false;
    const fetchMock = vi.fn();
    const deleteCache = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", { delete: deleteCache });
    const user = userEvent.setup();

    started = await startFieldApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
    );

    expect(started.status).toBe("offline_ready");
    expect(deleteCache.mock.calls).toEqual([
      [LEGACY_FIELD_API_CACHE],
      [LEGACY_FIELD_ALERT_CACHE],
    ]);
    expect(firebaseSdk.application).not.toHaveBeenCalled();
    expect(firebaseSdk.memoryOnlyAuth).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Current conditions" })).toBeVisible();
    expect(screen.getByText("Offline draft review is available")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reconnect to verify" })).toBeDisabled();

    await user.click(screen.getByRole("link", { name: "Report" }));
    expect(await screen.findByRole("heading", { name: "Report flooding" })).toBeVisible();
    expect(screen.getByText("Live incident context unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: /Save report offline/u })).toBeDisabled();
    expect(screen.queryByText("Aluva–Paravur Road")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    act(() => window.dispatchEvent(new Event("online")));
    const retry = await screen.findByRole("button", { name: "Verify secure access" });
    expect(retry).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Close report form" }));
    await user.click(screen.getByRole("link", { name: "Alerts" }));
    expect(await screen.findByRole("heading", { name: "Alerts" })).toBeVisible();
    expect(screen.getByText("Showing last-known alerts")).toBeVisible();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Verify secure access" }));
    expect(await screen.findByRole("heading", { name: "Verify your identity" })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fieldDb.queue.count()).toBe(0);
  });

  it("rejects a deterministic incident bootstrap in a live deployment", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const fetchMock = vi.fn().mockResolvedValue(liveBootstrapResponse({
      demo_mode: true,
      data_label: "DEMO DATA",
      incident: {
        id: "inc-demo-kerala-flood-2023",
        name: "Kerala extreme-rainfall deterministic replay",
        status: "ACTIVE",
        area_name: "Aluva, Kerala",
        is_demo: true,
        is_simulated: true,
        data_label: "DEMO DATA",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    started = await startFieldApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
    );

    expect(started.status).toBe("blocked");
    expect(await screen.findByRole("heading", { name: "Live access is paused" })).toBeVisible();
    expect(screen.getByText(/deterministic or simulated incident data/u)).toBeVisible();
    expect(document.body).not.toHaveTextContent("Aluva");
  });

  it("renders a validated authority incident without deterministic field content", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const fetchMock = vi.fn().mockResolvedValue(liveBootstrapResponse());
    vi.stubGlobal("fetch", fetchMock);

    started = await startFieldApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
    );

    expect(started.status).toBe("ready");
    expect(await screen.findByText("Authority incident connected")).toBeVisible();
    expect(screen.getByText(/Ernakulam monsoon response/u)).toBeVisible();
    expect(screen.getByText(/Live map layers are unavailable/u)).toBeVisible();
    expect(document.body).not.toHaveTextContent("DEMO DATA");
    expect(document.body).not.toHaveTextContent("Aluva");
    expect(document.body).not.toHaveTextContent("4 independent recent reports");

    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Report" }));
    expect(await screen.findByText("Device location required")).toBeVisible();
    expect(screen.getByText("No default location is used in live mode")).toBeVisible();
    expect(screen.getByRole("button", { name: /Submit report/u })).toBeDisabled();
    expect(document.body).not.toHaveTextContent("Aluva");

    await user.click(screen.getByRole("button", { name: "Close report form" }));
    await user.click(screen.getByRole("link", { name: "Route" }));
    expect(await screen.findByText("Location not selected")).toBeVisible();
    expect(screen.getByText(/Live mode never selects a demo origin/u)).toBeVisible();
    expect(document.body).not.toHaveTextContent("Aluva");
  });

  it("keeps the live API runtime fail-closed after the application is stopped", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const fetchMock = vi.fn().mockResolvedValue(liveBootstrapResponse());
    vi.stubGlobal("fetch", fetchMock);

    started = await startFieldApplication(
      document.getElementById("root")!,
      PRODUCTION_ENVIRONMENT,
      firebaseSdk,
    );
    expect(started.status).toBe("ready");

    started.stop();
    started = null;
    fetchMock.mockClear();

    await expect(submitReport(reportDraft())).rejects.toMatchObject({
      name: "ReportSubmissionError",
      retryable: true,
      message: expect.stringMatching(/authority incident is unavailable/i),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the deterministic demo independent of Firebase configuration", async () => {
    started = await startFieldApplication(document.getElementById("root")!, {
      VITE_DEMO_MODE: "true",
    });

    expect(started.status).toBe("ready");
    expect(await screen.findByRole("heading", { name: "Current conditions" })).toBeVisible();
    expect(firebaseSdk.application).not.toHaveBeenCalled();
    expect(firebaseSdk.memoryOnlyAuth).not.toHaveBeenCalled();
  });
});
