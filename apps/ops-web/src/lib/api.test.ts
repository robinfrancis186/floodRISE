import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiIdentityForRole,
  fetchOperationsSnapshot,
  submitApprovalDecision,
} from "./api";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("operations approval API", () => {
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
});
