import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actionStatusFromApproval,
  apiIdentityForRole,
  fetchOperationsSnapshot,
  signalDecisionFromState,
  signalStatusFromState,
  submitApprovalDecision,
  submitSignalDecision,
} from "./api";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" },
  });
}

const currentServerRoute = {
  id: "route-authoritative-9",
  label: "Via verified NH 544 segment",
  duration_min: 16,
  distance_km: 4.9,
  shelter: "Aluva School Shelter",
  shelter_id: "shelter-aluva-school",
  risk: "LOWER",
  reasons: ["Recalculated after corroborated road evidence"],
  model_version: "model-authoritative-009",
  evidence_version: "evidence-authoritative-014",
  valid_until: "2023-12-04T14:20:00Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("operations approval API", () => {
  it("maps authoritative review states without inferring client-only outcomes", () => {
    expect(actionStatusFromApproval("MODIFIED")).toBe("MODIFIED");
    expect(signalStatusFromState("NEEDS_REVIEW")).toBe("NEEDS_REVIEW");
    expect(signalDecisionFromState("NEEDS_REVIEW", "MODIFY")).toBe("FIELD_CHECK");
    expect(signalStatusFromState("DISPUTED")).toBe("DISPUTED");
    expect(signalDecisionFromState("DISPUTED")).toBe("REJECTED");
  });

  it("submits a field-check decision with its explicit server contract value", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: "signal-aluva",
      state: "NEEDS_REVIEW",
      version: 5,
      human_review: { decision: "FIELD_CHECK" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await submitSignalDecision(
      "signal-aluva",
      "FIELD_CHECK",
      "A responder field check is required.",
      4,
      apiIdentityForRole("Verifier"),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      decision: "FIELD_CHECK",
      expected_version: 4,
    });
  });

  it("maps the selected staff role to the demo authorization boundary", () => {
    expect(apiIdentityForRole("Incident commander")).toEqual({
      role: "incident_commander",
      userId: "ops-incident-commander",
    });
    expect(apiIdentityForRole("Field responder").role).toBe("responder");
    expect(apiIdentityForRole("Resilience engineer").role).toBe("engineer");
    expect(apiIdentityForRole("Identity administrator").role).toBe("identity_administrator");
  });

  it("submits the authoritative approval ID, expected version and selected identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      approval: {
        id: "approval-evacuation-demo",
        status: "APPROVED",
        version: 8,
        decided_by: "ops-verifier",
        execution_status: "SUCCEEDED",
      },
      alert: { id: "alert-approval-evacuation-demo" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await submitApprovalDecision(
      "approval-evacuation-demo",
      "APPROVE",
      "Independent review complete",
      7,
      apiIdentityForRole("Verifier"),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe("/api/v1/approvals/approval-evacuation-demo/decisions");
    expect(headers.get("X-Demo-Role")).toBe("verifier");
    expect(headers.get("X-Demo-User")).toBe("ops-verifier");
    expect(JSON.parse(String(init.body))).toEqual({
      decision: "APPROVE",
      reason: "Independent review complete",
      expected_version: 7,
    });
  });

  it("surfaces RFC 9457 approval failures with the server detail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      title: "Version conflict",
      detail: "Approval version is 8; expected 7",
      code: "VERSION_CONFLICT",
    }, 409)));

    await expect(submitApprovalDecision(
      "approval-evacuation-demo",
      "APPROVE",
      "Independent review complete",
      7,
      apiIdentityForRole("Verifier"),
    )).rejects.toMatchObject({
      message: "Approval version is 8; expected 7",
      status: 409,
      code: "VERSION_CONFLICT",
    });
  });

  it("hydrates presentation actions from real approval records", async () => {
    const approval = {
      id: "approval-evacuation-demo",
      incident_id: "inc-demo-kerala-flood-2023",
      action_type: "EVACUATION_GUIDANCE",
      action_payload: {
        presentation_id: "ACT-190",
        title: "Evacuation guidance for Ward 121",
        body: "Proceed using the bound lower-risk route.",
      },
      audience: "Ward 121 opted-in residents",
      evidence_version: "evidence-demo-001",
      model_version: "model-demo-001",
      status: "PENDING",
      requested_by: "demo-requester-evacuation-guidance",
      requested_role: "incident_commander",
      requested_at: "2023-12-04T14:10:00Z",
      expires_at: "2023-12-04T14:25:00Z",
      execution_status: "NOT_STARTED",
      version: 7,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "inc-demo-kerala-flood-2023" }] }))
      .mockResolvedValueOnce(jsonResponse({
        scenario_clock: "2023-12-04T14:10:00Z",
        simulation: { model_version: "model-demo-001" },
        approvals: [approval],
        signals: [],
        reports: [],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchOperationsSnapshot(apiIdentityForRole("Incident commander"));
    const action = result.snapshot.actions.find((item) => item.id === "ACT-190");

    expect(result.connected).toBe(true);
    expect(action).toMatchObject({
      approvalId: approval.id,
      approvalVersion: 7,
      status: "PENDING_APPROVAL",
      requestedById: approval.requested_by,
      evidenceVersion: approval.evidence_version,
      modelVersion: approval.model_version,
      detail: approval.action_payload.body,
    });
  });

  it("replaces fixture routes and source health with validated authoritative bootstrap records", async () => {
    const authoritativeSource = {
      id: "source-authoritative-gauge",
      provider: "Authorized river gauge",
      status: "STALE",
      observed_at: "2023-12-04T13:35:00Z",
      cadence: "15 min",
      is_simulated: false,
      quality_flags: ["LIVE_AUTHORIZED"],
      source_mode: "LIVE",
    };
    const packagedSource = {
      id: "osm-packaged-baseline",
      provider: "OpenStreetMap packaged baseline",
      status: "HEALTHY",
      observed_at: "2023-12-04T14:00:00Z",
      cadence: "Packaged snapshot",
      is_simulated: false,
      quality_flags: ["PACKAGED_BASELINE", "NOT_EVENT_TIME"],
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "inc-demo-kerala-flood-2023" }] }))
      .mockResolvedValueOnce(jsonResponse({
        scenario_clock: "2023-12-04T14:10:00Z",
        simulation: { model_version: "model-authoritative-009" },
        approvals: [],
        signals: [],
        reports: [],
        routes: [currentServerRoute],
        sources: [authoritativeSource, packagedSource],
      })));

    const result = await fetchOperationsSnapshot(apiIdentityForRole("Incident commander"));

    expect(result.connected).toBe(true);
    expect(result.snapshot.routes).toMatchObject([currentServerRoute]);
    expect(result.snapshot.routes[0]?.shelter_id).toBe("shelter-aluva-school");
    expect(result.snapshot.routes[0]).not.toHaveProperty("shelter_detail");
    expect(result.snapshot.routes.some((route) => route.id === "RTE-01")).toBe(false);
    expect(result.snapshot.sources).toEqual([
      authoritativeSource,
      { ...packagedSource, source_mode: "PACKAGED_BASELINE" },
    ]);
    expect(result.snapshot.sources.some((source) => source.id === "imd-warning")).toBe(false);
  });

  it("preserves authoritative shelter linkage and normalizes bound shelter detail", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "inc-demo-kerala-flood-2023" }] }))
      .mockResolvedValueOnce(jsonResponse({
        scenario_clock: "2023-12-04T14:10:00Z",
        routes: [{
          ...currentServerRoute,
          shelter_detail: {
            id: "shelter-aluva-school",
            name: "Aluva School Shelter",
            activation_status: "OPEN",
            access_status: "REACHABLE",
            capacity_total: 300,
            capacity_remaining: 162,
            verified_at: "2023-12-04T14:03:00Z",
            version: 4,
            warnings: ["CAPACITY_ESTIMATE"],
          },
        }],
        sources: [],
      })));

    const result = await fetchOperationsSnapshot(apiIdentityForRole("Incident commander"));

    expect(result.snapshot.routes[0]).toMatchObject({
      shelter_id: "shelter-aluva-school",
      shelter_detail: {
        id: "shelter-aluva-school",
        name: "Aluva School Shelter",
        status: "OPEN",
        access: "Reachable",
        capacity: 300,
        remaining_capacity: 162,
        observed_at: "2023-12-04T14:03:00Z",
        updated_minutes_ago: 7,
        version: 4,
        warnings: ["CAPACITY_ESTIMATE"],
      },
    });
  });

  it("fails closed to no routes when the authoritative bootstrap route is expired", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "inc-demo-kerala-flood-2023" }] }))
      .mockResolvedValueOnce(jsonResponse({
        scenario_clock: "2023-12-04T14:20:00Z",
        routes: [{ ...currentServerRoute, valid_until: "2023-12-04T14:20:00Z" }],
        sources: [],
      })));

    const result = await fetchOperationsSnapshot(apiIdentityForRole("Incident commander"));

    expect(result.connected).toBe(true);
    expect(result.snapshot.routes).toEqual([]);
  });

  it("preserves an authoritative empty route list without substituting demo alternatives", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "inc-demo-kerala-flood-2023" }] }))
      .mockResolvedValueOnce(jsonResponse({
        scenario_clock: "2023-12-04T14:10:00Z",
        routes: [],
        sources: [],
      })));

    const result = await fetchOperationsSnapshot(apiIdentityForRole("Incident commander"));

    expect(result.connected).toBe(true);
    expect(result.snapshot.routes).toEqual([]);
    expect(result.snapshot.sources).toEqual([]);
  });
});
