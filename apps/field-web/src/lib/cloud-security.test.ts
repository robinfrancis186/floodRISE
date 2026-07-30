import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORIZATION_HEADER,
  cloudFetch,
  configureCloudSecurity,
  FIREBASE_APP_CHECK_HEADER,
} from "./cloud-security";
import { DEMO_SCENARIO_TIME } from "../data/demo";
import type { OfflineReportDraft } from "./db";
import { submitReport } from "./api";

function response(status = 200) {
  return new Response(null, { status });
}

function requestHeaders(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  return new Headers(fetchMock.mock.calls[call]?.[1]?.headers as HeadersInit);
}

afterEach(() => {
  configureCloudSecurity(null);
  vi.unstubAllGlobals();
});

describe("field cloud security", () => {
  it("keeps demo requests free of App Check material and preserves request semantics", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    await cloudFetch("/api/v1/reports", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "report-12345678",
        [FIREBASE_APP_CHECK_HEADER]: "caller-supplied-token",
      },
      body: "{\"report\":true}",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has(FIREBASE_APP_CHECK_HEADER)).toBe(false);
    expect(headers.get("Idempotency-Key")).toBe("report-12345678");
    expect(init.credentials).toBe("include");
    expect(init.body).toBe("{\"report\":true}");
  });

  it("injects a validated provider token for an eligible API request", async () => {
    const tokenProvider = { getToken: vi.fn().mockResolvedValue({ token: "header.payload.signature" }) };
    configureCloudSecurity({ appCheck: tokenProvider });
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    await cloudFetch("/api/v1/reports", {
      method: "POST",
      headers: { "Idempotency-Key": "report-12345678" },
    });

    expect(requestHeaders(fetchMock).get(FIREBASE_APP_CHECK_HEADER))
      .toBe("header.payload.signature");
    expect(tokenProvider.getToken).toHaveBeenCalledWith(false);
  });

  it("protects the authoritative report endpoint through the field API integration", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    configureCloudSecurity({
      appCheck: { getToken: vi.fn().mockResolvedValue("report.header.signature") },
      bearer: { getToken: vi.fn().mockResolvedValue("identity.header.signature") },
    });
    const draft: OfflineReportDraft = {
      client_report_id: "report-app-check-0001",
      incident_id: "inc-demo-kerala-flood-2023",
      reporter_id: "reporter-field-1",
      device_id: "device-field-1",
      observed_at: DEMO_SCENARIO_TIME,
      location: { latitude: 10.1041, longitude: 76.3519, accuracy_m: 12 },
      water_depth: "KNEE",
      road_status: "DIFFICULT",
      infrastructure_issues: [],
      note: "Flooding observed.",
      place_label: "Aluva",
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      report: { id: "report-server-app-check" },
      receipt: {
        report_id: "report-server-app-check",
        client_report_id: draft.client_report_id,
        accepted_at: DEMO_SCENARIO_TIME,
        disposition: "ELIGIBLE",
        sync_message: "Report received.",
      },
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await submitReport(draft);

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/reports$/);
    expect(requestHeaders(fetchMock).get(FIREBASE_APP_CHECK_HEADER))
      .toBe("report.header.signature");
    expect(requestHeaders(fetchMock).get(AUTHORIZATION_HEADER))
      .toBe("Bearer identity.header.signature");
    expect(requestHeaders(fetchMock).get("Idempotency-Key")).toBe(draft.client_report_id);
    expect(requestHeaders(fetchMock).has("X-Demo-Role")).toBe(false);
    expect(requestHeaders(fetchMock).has("X-Demo-User")).toBe(false);
  });

  it("never sends the token to a backend-provided third-party upload URL", async () => {
    const appCheckProvider = { getToken: vi.fn().mockResolvedValue("header.payload.signature") };
    const bearerProvider = { getToken: vi.fn().mockResolvedValue("identity.payload.signature") };
    configureCloudSecurity({ appCheck: appCheckProvider, bearer: bearerProvider });
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    await cloudFetch("https://storage.googleapis.com/private-upload/signed", {
      method: "PUT",
      headers: {
        "Idempotency-Key": "media-upload-1",
        "X-Demo-Role": "reporter",
        "X-Demo-User": "field-pwa",
      },
    });

    expect(appCheckProvider.getToken).not.toHaveBeenCalled();
    expect(bearerProvider.getToken).not.toHaveBeenCalled();
    expect(requestHeaders(fetchMock).has(FIREBASE_APP_CHECK_HEADER)).toBe(false);
    expect(requestHeaders(fetchMock).has(AUTHORIZATION_HEADER)).toBe(false);
    expect(requestHeaders(fetchMock).has("X-Demo-Role")).toBe(false);
    expect(requestHeaders(fetchMock).has("X-Demo-User")).toBe(false);
  });

  it("does not start a live request when App Check is unavailable", async () => {
    const secret = "firebase-debug-token-must-not-leak";
    configureCloudSecurity({
      appCheck: {
        getToken: vi.fn().mockRejectedValue(new Error(`provider failed: ${secret}`)),
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(response(403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudFetch("/api/v1/reports", {
      method: "POST",
      headers: { "Idempotency-Key": "report-12345678" },
    })).rejects.toThrow("Device verification is unavailable");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(secret);
  });

  it("does not start a live request when identity is unavailable", async () => {
    const secret = "oidc-token-provider-secret";
    configureCloudSecurity({
      bearer: {
        getToken: vi.fn().mockRejectedValue(new Error(`identity failed: ${secret}`)),
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(response(401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudFetch("/api/v1/reports", {
      method: "POST",
      headers: {
        "Idempotency-Key": "report-12345678",
        "X-Demo-Role": "reporter",
        "X-Demo-User": "field-pwa",
      },
    })).rejects.toThrow("Identity verification is unavailable");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(secret);
  });

  it("stops every API caller before fetch while the offline-only shell is active", async () => {
    configureCloudSecurity({ blockApiRequests: true });
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudFetch("/api/v1/alerts"))
      .rejects.toThrow("Live network access is paused");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes once and retries an idempotency-protected write", async () => {
    const tokenProvider = {
      getToken: vi.fn()
        .mockResolvedValueOnce("old.header.signature")
        .mockResolvedValueOnce("fresh.header.signature"),
    };
    configureCloudSecurity({ appCheck: tokenProvider });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(201));
    vi.stubGlobal("fetch", fetchMock);

    const result = await cloudFetch("/api/v1/reports", {
      method: "POST",
      headers: { "Idempotency-Key": "report-12345678" },
      body: "{\"report\":true}",
    });

    expect(result.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokenProvider.getToken.mock.calls).toEqual([[false], [true]]);
    expect(requestHeaders(fetchMock, 0).get(FIREBASE_APP_CHECK_HEADER))
      .toBe("old.header.signature");
    expect(requestHeaders(fetchMock, 1).get(FIREBASE_APP_CHECK_HEADER))
      .toBe("fresh.header.signature");
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe("{\"report\":true}");
  });

  it("does not replay a write without an idempotency key", async () => {
    const tokenProvider = {
      getToken: vi.fn().mockResolvedValue("old.header.signature"),
    };
    configureCloudSecurity({ appCheck: tokenProvider });
    const fetchMock = vi.fn().mockResolvedValue(response(401));
    vi.stubGlobal("fetch", fetchMock);

    const result = await cloudFetch("/api/v1/routes/recommend", {
      method: "POST",
      body: "{\"origin\":true}",
    });

    expect(result.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenProvider.getToken).toHaveBeenCalledTimes(1);
  });

  it("does not replay when either required credential cannot be refreshed", async () => {
    const appCheck = {
      getToken: vi.fn()
        .mockResolvedValueOnce("old.app-check.token")
        .mockResolvedValueOnce("fresh.app-check.token"),
    };
    const bearer = {
      getToken: vi.fn()
        .mockResolvedValueOnce("old.identity.token")
        .mockResolvedValueOnce(null),
    };
    configureCloudSecurity({ appCheck, bearer });
    const fetchMock = vi.fn().mockResolvedValue(response(401));
    vi.stubGlobal("fetch", fetchMock);

    const result = await cloudFetch("/api/v1/reports", {
      method: "POST",
      headers: { "Idempotency-Key": "report-12345678" },
    });

    expect(result.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(appCheck.getToken.mock.calls).toEqual([[false], [true]]);
    expect(bearer.getToken.mock.calls).toEqual([[false], [true]]);
  });
});
