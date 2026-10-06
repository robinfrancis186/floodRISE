import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_SCENARIO_TIME, demoAlerts, demoRoutes } from "../data/demo";
import type { OfflineReportDraft } from "./db";
import {
  currentRoutesAt,
  fetchAlerts,
  fetchRoutes,
  isActiveAt,
  ReportSubmissionError,
  submitReport
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function reportDraft(withPhoto = true): OfflineReportDraft {
  return {
    client_report_id: "report-client-media-0001",
    incident_id: "inc-demo-michaung-2023",
    reporter_id: "reporter-field-1",
    device_id: "device-field-1",
    observed_at: DEMO_SCENARIO_TIME,
    location: { latitude: 12.9791, longitude: 80.2209, accuracy_m: 12 },
    water_depth: "KNEE",
    road_status: "DIFFICULT",
    infrastructure_issues: ["BLOCKED_DRAIN"],
    note: "Water rising beside the bus stop.",
    place_label: "Velachery Main Road",
    photo: withPhoto
      ? {
          name: "field-evidence.jpg",
          type: "image/jpeg",
          dataUrl: "data:image/jpeg;base64,AQIDBA=="
        }
      : undefined
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("private evidence upload", () => {
  it("quarantines and sanitizes a photo before attaching only its private upload id", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const uploadId = "upload-photo-1";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        upload_id: uploadId,
        status: "AWAITING_UPLOAD",
        upload_url: `/api/v1/media/uploads/${uploadId}/content`,
        completion_url: `/api/v1/media/uploads/${uploadId}/complete`
      }, 201))
      .mockResolvedValueOnce(jsonResponse({ upload_id: uploadId, status: "AWAITING_UPLOAD" }))
      .mockResolvedValueOnce(jsonResponse({ upload_id: uploadId, status: "QUARANTINED_PENDING_SCAN" }, 202))
      .mockResolvedValueOnce(jsonResponse({ upload_id: uploadId, status: "READY_PRIVATE" }))
      .mockResolvedValueOnce(jsonResponse({
        report: { id: "report-server-1" },
        receipt: {
          report_id: "report-server-1",
          client_report_id: "report-client-media-0001",
          accepted_at: DEMO_SCENARIO_TIME,
          disposition: "ELIGIBLE",
          sync_message: "Report received."
        }
      }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitReport(reportDraft())).resolves.toMatchObject({
      id: "report-server-1",
      source: "API"
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const grantBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      sha256: string;
      size_bytes: number;
    };
    expect(grantBody).toMatchObject({ size_bytes: 4 });
    expect(grantBody.sha256).toMatch(/^[a-f0-9]{64}$/);

    const contentHeaders = fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>;
    expect(contentHeaders["X-Checksum-SHA256"]).toBe(grantBody.sha256);
    expect(contentHeaders["Content-Type"]).toBe("image/jpeg");

    const reportBody = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)) as Record<string, unknown>;
    expect(reportBody.media_upload_ids).toEqual([uploadId]);
    expect(reportBody).not.toHaveProperty("photo");
    expect(reportBody).not.toHaveProperty("place_label");
    expect(JSON.stringify(reportBody)).not.toContain("AQIDBA");
  });

  it("fails closed when the scanner is unavailable and never creates the report", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const uploadId = "upload-photo-outage";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        upload_id: uploadId,
        status: "AWAITING_UPLOAD",
        upload_url: `/api/v1/media/uploads/${uploadId}/content`,
        completion_url: `/api/v1/media/uploads/${uploadId}/complete`
      }, 201))
      .mockResolvedValueOnce(jsonResponse({ upload_id: uploadId, status: "AWAITING_UPLOAD" }))
      .mockResolvedValueOnce(jsonResponse({ upload_id: uploadId, status: "QUARANTINED_PENDING_SCAN" }, 202))
      .mockResolvedValueOnce(jsonResponse({
        upload_id: uploadId,
        status: "QUARANTINED_SCANNER_UNAVAILABLE",
        failure_code: "MEDIA_SCANNER_UNAVAILABLE"
      }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitReport(reportDraft())).rejects.toMatchObject({
      name: "ReportSubmissionError",
      retryable: true,
      retryAfterMs: 30_000
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/reports"))).toBe(false);
  });

  it("submits a report without invoking the media API when no photo is selected", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      report: { id: "report-no-photo" },
      receipt: {
          report_id: "report-no-photo",
          client_report_id: "report-client-media-0001",
          accepted_at: DEMO_SCENARIO_TIME,
          disposition: "ELIGIBLE",
          sync_message: "Report received."
      }
    }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitReport(reportDraft(false))).resolves.toMatchObject({ id: "report-no-photo" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/reports$/);
    const reportBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(reportBody.media_upload_ids).toEqual([]);
  });

  it("never turns a report API outage into a synthetic receipt", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: "Authoritative report store unavailable."
    }), {
      status: 503,
      headers: { "Content-Type": "application/problem+json", "Retry-After": "12" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = submitReport(reportDraft(false));

    await expect(result).rejects.toBeInstanceOf(ReportSubmissionError);
    await expect(submitReport(reportDraft(false))).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 12_000
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("marks validation failures as needing user action instead of retrying forever", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      detail: "Observation location is outside the incident area."
    }, 422)));

    await expect(submitReport(reportDraft(false))).rejects.toMatchObject({
      name: "ReportSubmissionError",
      retryable: false,
      message: "Observation location is outside the incident area."
    });
  });

  it("fails closed when a successful report response has no authoritative receipt", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ok: true }, 200)));

    await expect(submitReport(reportDraft(false))).rejects.toMatchObject({
      name: "ReportSubmissionError",
      retryable: true,
      message: expect.stringMatching(/invalid acknowledgement/i)
    });
  });

  it("retries a rate-limited media grant using the server retry window", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: "Evidence intake is temporarily rate limited."
    }), {
      status: 429,
      headers: { "Content-Type": "application/problem+json", "Retry-After": "17" }
    })));

    await expect(submitReport(reportDraft())).rejects.toMatchObject({
      name: "ReportSubmissionError",
      retryable: true,
      retryAfterMs: 17_000
    });
  });
});

describe("deterministic field freshness", () => {
  it("keeps alert and route fixtures on the shared 14:10 UTC checkpoint", () => {
    expect(DEMO_SCENARIO_TIME).toBe("2023-12-04T14:10:00.000Z");
    expect(demoAlerts.every((alert) => isActiveAt(alert.issuedAt, alert.validUntil, DEMO_SCENARIO_TIME))).toBe(true);
    expect(currentRoutesAt(demoRoutes, DEMO_SCENARIO_TIME)).toHaveLength(demoRoutes.length);
  });

  it("removes a route at its exact expiry boundary", () => {
    const [route] = demoRoutes;
    expect(route).toBeDefined();
    expect(currentRoutesAt([route], route.valid_until)).toEqual([]);
  });

  it("withholds deterministic routes when the route API cannot verify freshness", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("API unavailable")));

    const result = await fetchRoutes();

    expect(result.availability).toBe("UNAVAILABLE");
    expect(result.source).toBe("DEMO_FALLBACK");
    expect(result.alternatives).toEqual([]);
    expect(result.message).toMatch(/withheld.*freshness cannot be verified/i);
  });

  it("rejects expired alternatives returned by an otherwise successful API", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const expired = { ...demoRoutes[0], valid_until: "2023-12-04T14:09:59.000Z" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      generated_at: DEMO_SCENARIO_TIME,
      alternatives: [expired],
      no_route_reason: "Route evidence expired."
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await fetchRoutes();

    expect(result).toMatchObject({
      availability: "UNAVAILABLE",
      source: "API",
      alternatives: [],
      message: "Route evidence expired."
    });
  });

  it("returns only active deterministic alerts after an API failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("API unavailable")));

    const alerts = await fetchAlerts();

    expect(alerts).toHaveLength(demoAlerts.length);
    expect(alerts.every((alert) => isActiveAt(alert.issuedAt, alert.validUntil, DEMO_SCENARIO_TIME))).toBe(true);
  });

  it("normalizes authoritative API alerts before rendering the field feed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [{
        id: "caution-signal-1-v1",
        title: "Community-corroborated flooding nearby",
        body: "Corroborated by 4 independent recent reports; not an official confirmation.",
        audience: "Opted-in users inside the hazard footprint plus 1 km",
        caution_only: true,
        official: false,
        created_at: "2023-12-04T14:10:00.000Z",
        dispatched_at: "2023-12-04T14:10:01.000Z",
        expires_at: "2023-12-04T14:40:00.000Z",
        is_demo: true
      }],
      next_cursor: null
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const alerts = await fetchAlerts();

    expect(alerts).toEqual([{
      id: "caution-signal-1-v1",
      kind: "COMMUNITY_CAUTION",
      title: "Community-corroborated flooding nearby",
      description: "Corroborated by 4 independent recent reports; not an official confirmation.",
      area: "Opted-in users inside the hazard footprint plus 1 km",
      issuedAt: "2023-12-04T14:10:01.000Z",
      validUntil: "2023-12-04T14:40:00.000Z",
      severity: "CAUTION",
      isSimulated: true
    }]);
  });
});

describe("nearby OpenStreetMap hospitals", () => {
  it("requests hospitals nearest the origin and keeps the OSM attribution", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      items: [{
        id: "osm-node-1", kind: "HOSPITAL", name: "Demo Hospital", names: { ta: "மருத்துவமனை" },
        location: { latitude: 12.98, longitude: 80.22 }, distance_m: 420
      }],
      attribution: "© OpenStreetMap contributors",
      notice: "Mapped locations only."
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchNearbyHospitals } = await import("./api");
    const result = await fetchNearbyHospitals({ latitude: 12.9791, longitude: 80.2209 }, 3);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
    expect(url.pathname).toBe("/api/v1/osm/facilities");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      kind: "HOSPITAL", latitude: "12.9791", longitude: "80.2209", limit: "3"
    });
    expect(result?.items[0]?.names.ta).toBe("மருத்துவமனை");
    expect(result?.attribution).toBe("© OpenStreetMap contributors");
  });

  it("returns null instead of throwing when the API is unreachable or malformed", async () => {
    const { fetchNearbyHospitals } = await import("./api");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await fetchNearbyHospitals()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    expect(await fetchNearbyHospitals()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    expect(await fetchNearbyHospitals()).toBeNull();
  });
});
