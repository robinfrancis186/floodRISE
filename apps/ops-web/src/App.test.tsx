import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { operationsEventCursorKey } from "./lib/operations-events";
import { NoRouteState } from "./views/evacuation-view";

vi.mock("@floodrise/map", () => ({
  FloodMap: ({
    ariaLabel,
    visibleFeatureIds,
    resilienceLayers,
    showRouteGeometry,
  }: {
    ariaLabel?: string;
    visibleFeatureIds?: readonly string[];
    resilienceLayers?: { recurringFlooding: boolean };
    showRouteGeometry?: boolean;
  }) => <div
    data-testid="flood-map"
    data-visible-feature-ids={visibleFeatureIds?.join(",")}
    data-recurring-flooding={resilienceLayers ? String(resilienceLayers.recurringFlooding) : undefined}
    data-route-geometry={showRouteGeometry === false ? "hidden" : "default"}
    aria-label={ariaLabel}
  >Deterministic Kerala map</div>,
}));

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" },
  });
}

function installBootstrapProjectionApi(bootstrap: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/incidents")) {
      return jsonResponse({ items: [{ id: "inc-demo-kerala-flood-2023" }] });
    }
    if (url.includes("/incidents/inc-demo-kerala-flood-2023/bootstrap")) {
      return jsonResponse({
        scenario_clock: "2023-12-04T14:10:00Z",
        approvals: [],
        signals: [],
        reports: [],
        shelters: [],
        sources: [],
        routes: [],
        ...bootstrap,
      });
    }
    if (url.includes("/events?incident_id=")) {
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    throw new Error(`Unexpected test request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function installApprovalApi(decisionStatus = 200) {
  const approvals = [
    {
      id: "approval-area-demo",
      action_type: "AREA_CAUTION",
      action_payload: { presentation_id: "ACT-204", title: "Issue area caution and reroute teams", body: "Issue an opt-in caution." },
      audience: "Aluva hazard footprint + 1 km",
      evidence_version: "evidence-demo-001",
      model_version: "model-demo-001",
      status: "PENDING",
      requested_by: "demo-requester-area-caution",
      requested_role: "incident_commander",
      requested_at: "2023-12-04T14:10:00Z",
      expires_at: "2023-12-04T14:25:00Z",
      execution_status: "NOT_STARTED",
      version: 4,
    },
    {
      id: "approval-evacuation-demo",
      action_type: "EVACUATION_GUIDANCE",
      action_payload: { presentation_id: "ACT-190", title: "Evacuation guidance for Ward 121", body: "Proceed using the bound lower-risk route." },
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
    },
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/incidents")) return jsonResponse({ items: [{ id: "inc-demo-kerala-flood-2023" }] });
    if (url.includes("/incidents/inc-demo-kerala-flood-2023/bootstrap")) {
      return jsonResponse({
        scenario_clock: "2023-12-04T14:10:00Z",
        simulation: { model_version: "model-demo-001" },
        approvals,
        signals: [],
        reports: [],
        routes: [{
          id: "route-approval-test",
          label: "Via NH 544",
          duration_min: 18,
          distance_km: 5.6,
          shelter: "Kendriya Vidyalaya Shelter",
          shelter_id: "shelter-kendriya",
          risk: "LOWER",
          reasons: ["Avoids three modelled flooded segments"],
          model_version: "model-demo-001",
          evidence_version: "evidence-demo-001",
          valid_until: "2023-12-04T14:20:00Z",
        }],
        shelters: [{
          id: "shelter-kendriya",
          name: "Kendriya Vidyalaya Shelter",
          activation_status: "OPEN",
          access_status: "REACHABLE",
          capacity_total: 450,
          capacity_remaining: 226,
          occupancy: 224,
          verified_at: "2023-12-04T14:03:00Z",
          version: 3,
        }],
      });
    }
    if (
      url.includes("/approvals/approval-evacuation-demo/decisions")
      || url.includes("/approvals/approval-area-demo/decisions")
    ) {
      const approvalId = url.includes("approval-area-demo")
        ? "approval-area-demo"
        : "approval-evacuation-demo";
      const expectedVersion = approvalId === "approval-area-demo" ? 4 : 7;
      if (decisionStatus >= 400) {
        return jsonResponse({
          title: "Version conflict",
          detail: `Approval version is ${expectedVersion + 1}; expected ${expectedVersion}`,
          code: "VERSION_CONFLICT",
        }, decisionStatus);
      }
      const requestBody = JSON.parse(String(_init?.body)) as { decision: string; reason: string };
      const status = requestBody.decision === "MODIFY"
        ? "MODIFIED"
        : requestBody.decision === "REJECT"
          ? "REJECTED"
          : "APPROVED";
      return jsonResponse({
        approval: {
          id: approvalId,
          status,
          version: expectedVersion + 1,
          decided_by: "ops-verifier",
          decision_reason: requestBody.reason,
          execution_status: status === "APPROVED" ? "SUCCEEDED" : "NOT_STARTED",
        },
        alert: status === "APPROVED" ? { id: `alert-${approvalId}` } : null,
      });
    }
    throw new Error(`Unexpected test request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function installSignalApi(decisionStatus = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/incidents")) return jsonResponse({ items: [{ id: "inc-demo-kerala-flood-2023" }] });
    if (url.includes("/incidents/inc-demo-kerala-flood-2023/bootstrap")) {
      return jsonResponse({
        scenario_clock: "2023-12-04T14:10:00Z",
        simulation: { model_version: "model-demo-001" },
        approvals: [],
        signals: [{
          id: "signal-aluva",
          state: "CORROBORATING",
          report_count: 4,
          independent_report_count: 4,
          authenticated_report_count: 2,
          confidence: 0.84,
          version: 4,
        }],
        reports: [],
      });
    }
    if (url.includes("/signals/signal-aluva/decisions")) {
      if (decisionStatus >= 400) {
        return jsonResponse({
          title: "Version conflict",
          detail: "Signal version is 5; expected 4",
          code: "VERSION_CONFLICT",
        }, decisionStatus);
      }
      return jsonResponse({
        id: "signal-aluva",
        state: "COMMUNITY_CORROBORATED",
        human_decision: "VERIFY",
        version: 5,
      });
    }
    throw new Error(`Unexpected test request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function installShelterApi(updateStatus = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/incidents")) return jsonResponse({ items: [{ id: "inc-demo-kerala-flood-2023" }] });
    if (url.includes("/incidents/inc-demo-kerala-flood-2023/bootstrap")) {
      return jsonResponse({
        scenario_clock: "2023-12-04T14:10:00Z",
        simulation: { model_version: "model-demo-001" },
        approvals: [],
        signals: [],
        reports: [],
        shelters: [{
          id: "shelter-aluva-school",
          name: "Aluva School Shelter",
          activation_status: "OPEN",
          access_status: "REACHABLE",
          capacity_total: 300,
          capacity_remaining: 162,
          occupancy: 138,
          verified_at: "2023-12-04T14:03:00Z",
          version: 3,
        }],
      });
    }
    if (url.includes("/shelters/shelter-aluva-school")) {
      if (updateStatus >= 400) {
        return jsonResponse({
          title: "Version conflict",
          detail: "Shelter version is 4; expected 3",
          code: "VERSION_CONFLICT",
        }, updateStatus);
      }
      const body = JSON.parse(String(init?.body));
      return jsonResponse({
        id: "shelter-aluva-school",
        activation_status: body.activation_status,
        access_status: body.access_status,
        capacity_total: 300,
        capacity_remaining: body.capacity_remaining,
        occupancy: 300 - body.capacity_remaining,
        verified_at: "2023-12-04T14:10:00Z",
        version: 4,
      });
    }
    throw new Error(`Unexpected test request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function installAuditApi(options: { chainValid?: boolean; auditStatus?: number } = {}) {
  const { chainValid = true, auditStatus = 200 } = options;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/incidents")) return jsonResponse({ items: [{ id: "inc-demo-kerala-flood-2023" }] });
    if (url.includes("/incidents/inc-demo-kerala-flood-2023/bootstrap")) {
      return jsonResponse({ scenario_clock: "2023-12-04T14:10:00Z", simulation: { model_version: "model-demo-001" }, approvals: [], signals: [], reports: [], shelters: [] });
    }
    if (url.includes("/audit?limit=200")) {
      if (auditStatus >= 400) return jsonResponse({ title: "Audit unavailable", detail: "Audit verification service is unavailable." }, auditStatus);
      return jsonResponse({
        chain_valid: chainValid,
        items: [{
          id: "evt-authoritative-1",
          event_type: "shelter.status_updated",
          aggregate_kind: "shelter",
          aggregate_id: "shelter-aluva-school",
          aggregate_version: 4,
          actor_id: "ops-shelter-manager",
          actor_role: "shelter_manager",
          created_at: "2023-12-04T14:10:00Z",
          event_hash: "b9ca3fefb4014d25251fcbb0e6f1a447ca29c45ad84ab54dbbef4e29931e45af",
        }],
      });
    }
    throw new Error(`Unexpected test request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

function installLiveEventsApi() {
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let bootstrapRequests = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/incidents")) return jsonResponse({ items: [{ id: "inc-demo-kerala-flood-2023" }] });
    if (url.includes("/incidents/inc-demo-kerala-flood-2023/bootstrap")) {
      bootstrapRequests += 1;
      return jsonResponse({
        scenario_clock: "2023-12-04T14:10:00Z",
        simulation: { model_version: `model-demo-${bootstrapRequests}` },
        approvals: [],
        signals: [],
        reports: [],
      });
    }
    if (url.includes("/events?incident_id=")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          eventController = controller;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    throw new Error(`Unexpected test request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    emit(sequence: number) {
      const data = {
        id: `evt-${sequence}`,
        type: "simulation.published",
        incident_id: "inc-demo-kerala-flood-2023",
        resource_id: `model-demo-${sequence}`,
        version: sequence,
        occurred_at: "2023-12-04T14:10:02Z",
      };
      eventController?.enqueue(new TextEncoder().encode(
        `id: ${sequence}\nevent: simulation.published\ndata: ${JSON.stringify(data)}\n\n`,
      ));
    },
    fail() {
      eventController?.error(new TypeError("stream disconnected"));
    },
    bootstrapCount() {
      return bootstrapRequests;
    },
  };
}

function installDemoControlApi() {
  let scenarioTime = "2023-12-04T14:10:00Z";
  let modelVersion = "model-demo-reset";
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/incidents")) {
      return jsonResponse({ items: [{ id: "inc-demo-kerala-flood-2023" }] });
    }
    if (url.includes("/incidents/inc-demo-kerala-flood-2023/bootstrap")) {
      return jsonResponse({
        scenario_clock: scenarioTime,
        simulation: { model_version: modelVersion },
        approvals: [],
        signals: [],
        reports: [],
      });
    }
    if (url.endsWith("/demo/advance")) {
      scenarioTime = "2023-12-04T14:20:00Z";
      modelVersion = "model-demo-advanced";
      return jsonResponse({ scenario_time: scenarioTime });
    }
    if (url.endsWith("/demo/reset")) {
      scenarioTime = "2023-12-04T14:10:00Z";
      modelVersion = "model-demo-reset";
      return jsonResponse({ scenario_time: scenarioTime });
    }
    if (url.includes("/events?incident_id=")) {
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    throw new Error(`Unexpected test request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("operations console", () => {
  it("refetches authoritative state after a persisted invalidation and exposes stream health", async () => {
    const liveApi = installLiveEventsApi();
    renderApp();

    expect(await screen.findByText("API synced", { exact: true })).toBeInTheDocument();
    expect(liveApi.bootstrapCount()).toBe(1);

    liveApi.emit(12);
    await waitFor(() => expect(liveApi.bootstrapCount()).toBe(2));
    expect(window.localStorage.getItem(operationsEventCursorKey(
      "inc-demo-kerala-flood-2023",
      "ops-incident-commander",
    ))).toBe("12");

    liveApi.fail();
    expect(await screen.findByText("API connected · live updates reconnecting", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("API synced", { exact: true })).not.toBeInTheDocument();
  });

  it("navigates all primary workflows with a real URL route", async () => {
    const user = userEvent.setup();
    renderApp();
    expect(screen.getByRole("heading", { name: "Live Operations" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "FloodSignal" }));
    expect(window.location.pathname).toBe("/signals");
    expect(screen.getByRole("heading", { name: "FloodSignal Review" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: /Aluva evidence review/i })).toBeInTheDocument();
  });

  it("does not present unavailable demo-wide tools or informational reasons as active controls", () => {
    renderApp();

    expect(screen.getByLabelText("Selected incident: Ernakulam Kerala extreme-rainfall replay")).not.toHaveAttribute("type", "button");
    expect(screen.getByLabelText("Search unavailable in demo mode")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Notifications unavailable in demo" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Rainfall increase/ })).not.toBeInTheDocument();
    expect(screen.getByText("Rainfall increase")).toBeInTheDocument();
    const auditNavigation = screen.getByRole("button", { name: "Audit Log" });
    expect(auditNavigation).toHaveAttribute("title", "Audit Log");
    expect(within(auditNavigation).getByText("Audit", { exact: true })).toHaveAttribute("aria-hidden", "true");
  });

  it("makes incident actions explicit, exports a demo brief, and opens command workspace", async () => {
    const user = userEvent.setup();
    const NativeUrl = URL;
    const createObjectUrl = vi.fn(() => "blob:incident-brief");
    const revokeObjectUrl = vi.fn();
    class DownloadUrl extends NativeUrl {}
    Object.defineProperties(DownloadUrl, {
      createObjectURL: { value: createObjectUrl },
      revokeObjectURL: { value: revokeObjectUrl },
    });
    vi.stubGlobal("URL", DownloadUrl);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    window.history.replaceState({}, "", "/incidents");
    renderApp();

    expect(screen.getByRole("button", { name: "Create incident unavailable in demo" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Export incident brief" }));
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:incident-brief");
    expect(screen.getByText(/Demo brief downloaded.*not an official public warning/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open command workspace" }));
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("heading", { name: "Live Operations" })).toBeInTheDocument();
  });

  it("reveals and hides the no-route staging reference", async () => {
    const user = userEvent.setup();
    render(<NoRouteState />);

    const show = screen.getByRole("button", { name: "View staging point" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    await user.click(show);
    expect(screen.getByText("Aluva Fire & Rescue Station forecourt")).toBeInTheDocument();
    expect(screen.getByText(/confirm local access with field command/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide staging point" }));
    expect(screen.queryByText("Aluva Fire & Rescue Station forecourt")).not.toBeInTheDocument();
  });

  it("renders the integrated no-route state when the authoritative alternative list is empty", async () => {
    const user = userEvent.setup();
    installBootstrapProjectionApi({ routes: [] });
    window.history.replaceState({}, "", "/evacuation");
    renderApp();
    expect(await screen.findByRole("heading", { name: "No compliant route available" })).toBeInTheDocument();
    expect(screen.getByText("API synced", { exact: true })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View staging point" }));
    expect(screen.getByText("Aluva Fire & Rescue Station forecourt")).toBeInTheDocument();
  });

  it("binds a route to the exact authoritative shelter record and formats validity in IST", async () => {
    installBootstrapProjectionApi({
      routes: [{
        id: "route-authoritative-open",
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
      }],
      shelters: [{
        id: "shelter-aluva-school",
        name: "Aluva School Shelter",
        activation_status: "OPEN",
        access_status: "REACHABLE",
        capacity_total: 300,
        capacity_remaining: 162,
        occupancy: 138,
        verified_at: "2023-12-04T14:03:00Z",
        version: 3,
      }],
    });
    window.history.replaceState({}, "", "/evacuation");
    renderApp();

    expect(await screen.findByText("Shelter record: OPEN · Reachable · updated 7 min ago")).toBeInTheDocument();
    expect(screen.getByText("Valid until 19:50 IST")).toBeInTheDocument();
    expect(screen.queryByText(/Shelter status confirmed open/i)).not.toBeInTheDocument();
  });

  it("withholds routes to unusable linked shelters and labels unmatched destinations unverified", async () => {
    installBootstrapProjectionApi({
      routes: [{
        id: "route-full-shelter",
        label: "Route to full shelter",
        duration_min: 14,
        distance_km: 3.8,
        shelter: "Aluva School Shelter",
        shelter_id: "shelter-aluva-school",
        risk: "LOWER",
        reasons: ["Shortest compliant road path"],
        model_version: "model-authoritative-009",
        evidence_version: "evidence-authoritative-014",
        valid_until: "2023-12-04T14:20:00Z",
      }, {
        id: "route-unverified-shelter",
        label: "Route to unlisted relief centre",
        duration_min: 21,
        distance_km: 6.2,
        shelter: "Unlisted Relief Centre",
        risk: "ELEVATED",
        reasons: ["Shelter linkage is incomplete"],
        model_version: "model-authoritative-009",
        evidence_version: "evidence-authoritative-014",
        valid_until: "2023-12-04T14:20:00Z",
      }],
      shelters: [{
        id: "shelter-aluva-school",
        name: "Aluva School Shelter",
        activation_status: "FULL",
        access_status: "REACHABLE",
        capacity_total: 300,
        capacity_remaining: 0,
        occupancy: 300,
        verified_at: "2023-12-04T14:08:00Z",
        version: 4,
      }],
    });
    window.history.replaceState({}, "", "/evacuation");
    renderApp();

    expect(await screen.findAllByText("Route to unlisted relief centre")).toHaveLength(2);
    expect(screen.queryByText("Route to full shelter")).not.toBeInTheDocument();
    expect(screen.getByText(/1 alternative withheld because the linked shelter is full or not currently reachable/i)).toBeInTheDocument();
    expect(screen.getByText(/Shelter status unverified; confirm with the shelter desk before movement/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review guidance approval" })).toBeDisabled();
  });

  it("renders connected authoritative source health without fixture substitution", async () => {
    installBootstrapProjectionApi({
      sources: [{
        id: "source-authoritative-gauge",
        provider: "Authorized river gauge",
        status: "STALE",
        observed_at: "2023-12-04T13:35:00Z",
        cadence: "15 min",
        is_simulated: false,
        quality_flags: ["LIVE_AUTHORIZED"],
        source_mode: "LIVE",
      }, {
        id: "osm-packaged-baseline",
        provider: "OpenStreetMap packaged baseline",
        status: "HEALTHY",
        observed_at: "2023-12-04T14:00:00Z",
        cadence: "Packaged snapshot",
        is_simulated: false,
        quality_flags: ["PACKAGED_BASELINE", "NOT_EVENT_TIME"],
      }],
    });
    window.history.replaceState({}, "", "/sources");
    renderApp();

    expect(await screen.findByText("Authorized river gauge")).toBeInTheDocument();
    expect(screen.getByText("Scenario clock 19:40 IST")).toBeInTheDocument();
    expect(screen.getByText("1 stale")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Authorized river gauge/ })).getByText("LIVE")).toBeInTheDocument();
    const packagedRow = screen.getByRole("row", { name: /OpenStreetMap packaged baseline/ });
    expect(within(packagedRow).getByText("PACKAGED BASELINE")).toBeInTheDocument();
    expect(within(packagedRow).getByText("Not event-time")).toBeInTheDocument();
    expect(within(packagedRow).queryByText("0 min")).not.toBeInTheDocument();
    expect(within(packagedRow).queryByText("LIVE")).not.toBeInTheDocument();
    expect(screen.queryByText("IMD weather warning")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Operational source health table" })).toHaveAttribute("tabindex", "0");
  });

  it("labels unavailable field dispatch instead of presenting an inert action", () => {
    window.history.replaceState({}, "", "/evacuation");
    renderApp();

    expect(screen.getByRole("button", { name: "Send to field team" })).toBeDisabled();
    expect(screen.getByText(/Field dispatch is unavailable in demo mode/i)).toBeInTheDocument();
    expect(screen.getByTestId("flood-map")).toHaveAttribute("data-route-geometry", "hidden");
    expect(screen.getByText(/Route geometry is not displayed.*do not infer a path/i)).toBeInTheDocument();
  });

  it("filters FloodSignal clusters by ward and freshness and collapses the controls", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/signals");
    renderApp();

    await user.click(screen.getByRole("button", { name: /ELO-018 · Eloor/ }));
    await user.selectOptions(screen.getByLabelText("Freshness"), "5m");
    expect(screen.getByText("Showing 2 of 5 clusters")).toBeInTheDocument();
    expect(screen.queryByText(/KDG-031 · Kadungalloor/)).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: /Eloor evidence review/ })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Freshness"), "3h");
    await user.selectOptions(screen.getByLabelText("Ward"), "Ward 121");
    expect(screen.getByText("Showing 1 of 5 clusters")).toBeInTheDocument();
    expect(screen.getAllByText(/KDG-031 · Kadungalloor/)).toHaveLength(2);
    expect(screen.getByRole("complementary", { name: /Kadungalloor evidence review/ })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Freshness"), "5m");
    expect(screen.getByText("Showing 0 of 5 clusters")).toBeInTheDocument();
    expect(screen.getByText("No actionable cluster")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify flooding" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide filters" }));
    expect(screen.getByRole("button", { name: "Show filters" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("Freshness")).not.toBeVisible();
  });

  it("applies resilience filters and layers to the ranked list and mapped hotspots", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/resilience");
    renderApp();
    const map = screen.getByTestId("flood-map");

    expect(map).toHaveAttribute("data-visible-feature-ids", "hotspot-1,hotspot-2,hotspot-3,hotspot-4,hotspot-5");
    await user.selectOptions(screen.getByLabelText("Event range"), "2026");
    expect(screen.getByText("Showing 1 of 5 ranked priorities. Filters also update the mapped hotspot markers.")).toBeInTheDocument();
    expect(map).toHaveAttribute("data-visible-feature-ids", "hotspot-1");

    await user.selectOptions(screen.getByLabelText("Asset type"), "Road");
    expect(screen.getByText("No priorities match")).toBeInTheDocument();
    expect(map).toHaveAttribute("data-visible-feature-ids", "");

    await user.selectOptions(screen.getByLabelText("Event range"), "all");
    await user.selectOptions(screen.getByLabelText("Asset type"), "all");
    await user.selectOptions(screen.getByLabelText("Evidence quality"), "official");
    expect(screen.getByText("Showing 3 of 5 ranked priorities. Filters also update the mapped hotspot markers.")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Recurring flooding"));
    expect(map).toHaveAttribute("data-recurring-flooding", "false");
    expect(map).toHaveAttribute("data-visible-feature-ids", "");
  });

  it("creates local resilience drafts, records an engineer note, and closes and reopens detail", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/resilience");
    renderApp();

    expect(screen.getByRole("button", { name: "Request authority review" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Create inspection draft" }));
    expect(screen.getByRole("button", { name: "Inspection draft created" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add engineer note" }));
    const dialog = screen.getByRole("dialog", { name: "Add engineer note" });
    await user.type(within(dialog).getByLabelText(/Engineer note/), "Inspect the upstream grate before monsoon desilting.");
    await user.click(within(dialog).getByRole("button", { name: "Save local note" }));
    expect(screen.getByText("Inspect the upstream grate before monsoon desilting.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit engineer note" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("button", { name: "Edit engineer note" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("row", { name: /Kadungalloor drain corridor/ }));
    expect(screen.getByRole("button", { name: "Edit engineer note" })).toBeInTheDocument();
  });

  it("records a community-corroboration decision with explicit safety wording", async () => {
    const user = userEvent.setup();
    installSignalApi();
    window.history.replaceState({}, "", "/signals");
    renderApp();
    await waitFor(() => expect(screen.getByRole("button", { name: /Verify flooding/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Verify flooding/i }));
    const dialog = screen.getByRole("dialog", { name: /Verify community corroboration/i });
    expect(dialog).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Verify flooding" }));
    expect(await screen.findByText("Community corroboration recorded — not an official confirmation.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /Verify community corroboration/i })).not.toBeInTheDocument();
  });

  it("keeps FloodSignal evidence unchanged when the server rejects the decision", async () => {
    const user = userEvent.setup();
    installSignalApi(409);
    window.history.replaceState({}, "", "/signals");
    renderApp();
    await waitFor(() => expect(screen.getByRole("button", { name: /Verify flooding/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Verify flooding/i }));
    const dialog = screen.getByRole("dialog", { name: /Verify community corroboration/i });
    await user.click(within(dialog).getByRole("button", { name: "Verify flooding" }));

    expect(await screen.findByText(/FloodSignal decision not recorded.*version is 5; expected 4.*Evidence remains unchanged/i)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: /Verify community corroboration/i })).toBeInTheDocument();
    expect(screen.queryByText("Community corroboration recorded — not an official confirmation.")).not.toBeInTheDocument();
  });

  it("enforces role permissions for operational approvals", async () => {
    const user = userEvent.setup();
    installApprovalApi();
    renderApp();
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve action" })).toBeEnabled());
    await user.selectOptions(screen.getByLabelText("Active role"), "Auditor");
    await user.click(screen.getByRole("button", { name: "Approve action" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve action" }));
    expect(await screen.findByText(/This role cannot approve operational actions/i)).toBeInTheDocument();
  });

  it("returns an action for changes without presenting it as dispatched", async () => {
    const user = userEvent.setup();
    const fetchMock = installApprovalApi();
    renderApp();
    const requestChanges = screen.getByRole("button", { name: "Request changes" });
    await waitFor(() => expect(requestChanges).toBeEnabled());
    await user.selectOptions(screen.getByLabelText("Active role"), "Verifier");
    await user.click(requestChanges);
    const dialog = screen.getByRole("dialog", { name: "Return action for changes" });
    await user.type(
      within(dialog).getByLabelText(/Decision note/i),
      "Narrow the audience and submit a newly bound request.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Return for changes" }));

    expect(await screen.findByText(/Action returned for changes.*server recorded/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request changes" })).toBeDisabled();
    const decisionCall = fetchMock.mock.calls.find(([input]) => (
      String(input).includes("/approvals/approval-area-demo/decisions")
    ));
    expect(decisionCall).toBeDefined();
    expect(JSON.parse(String((decisionCall?.[1] as RequestInit).body)).decision).toBe("MODIFY");
  });

  it("records a seeded evacuation approval using its authoritative ID, version and active role", async () => {
    const user = userEvent.setup();
    const fetchMock = installApprovalApi();
    window.history.replaceState({}, "", "/evacuation");
    renderApp();
    const review = screen.getByRole("button", { name: "Review guidance approval" });
    await waitFor(() => expect(review).toBeEnabled());
    await user.selectOptions(screen.getByLabelText("Active role"), "Verifier");
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      return headers.get("X-Demo-Role") === "verifier";
    })).toBe(true));
    await user.click(review);
    const dialog = screen.getByRole("dialog", { name: "Approve evacuation guidance" });
    await user.type(within(dialog).getByLabelText(/Decision note/i), "Independent review complete");
    await user.click(within(dialog).getByRole("button", { name: "Approve guidance" }));

    expect(await screen.findByText(/server recorded the decision and bound versions/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Guidance approved" })).toBeDisabled();
    const decisionCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/approvals/approval-evacuation-demo/decisions"));
    expect(decisionCall).toBeDefined();
    const decisionInit = decisionCall?.[1] as RequestInit;
    const headers = new Headers(decisionInit.headers);
    expect(headers.get("X-Demo-Role")).toBe("verifier");
    expect(headers.get("X-Demo-User")).toBe("ops-verifier");
    expect(JSON.parse(String(decisionInit.body)).expected_version).toBe(7);
  });

  it("keeps a pending action unchanged and shows the server error when approval fails", async () => {
    const user = userEvent.setup();
    installApprovalApi(409);
    window.history.replaceState({}, "", "/evacuation");
    renderApp();
    const review = screen.getByRole("button", { name: "Review guidance approval" });
    await waitFor(() => expect(review).toBeEnabled());
    await user.click(review);
    const dialog = screen.getByRole("dialog", { name: "Approve evacuation guidance" });
    await user.click(within(dialog).getByRole("button", { name: "Approve guidance" }));

    expect(await screen.findByText(/Approval not recorded.*version is 8; expected 7.*action remains pending/i)).toBeInTheDocument();
    const retainedDialog = screen.getByRole("dialog", { name: "Approve evacuation guidance" });
    expect(retainedDialog).toBeInTheDocument();
    await user.click(within(retainedDialog).getByRole("button", { name: "Close decision dialog" }));
    expect(screen.getByRole("button", { name: "Review guidance approval" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Guidance approved" })).not.toBeInTheDocument();
  });

  it("updates shelter status only after the server confirms the selected role and version", async () => {
    const user = userEvent.setup();
    const fetchMock = installShelterApi();
    window.history.replaceState({}, "", "/shelters");
    renderApp();
    await user.selectOptions(screen.getByLabelText("Active role"), "Shelter manager");
    const save = screen.getByRole("button", { name: "Save status" });
    await waitFor(() => expect(save).toBeDisabled());
    await user.selectOptions(screen.getByLabelText("Status"), "LIMITED");
    await user.clear(screen.getByLabelText("Current occupancy"));
    await user.type(screen.getByLabelText("Current occupancy"), "150");
    await user.type(screen.getByLabelText("Update reason"), "Capacity verified by shelter desk");
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);

    expect(await screen.findByText(/Shelter status confirmed by the server/i)).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Aluva School Shelter/ })).toHaveTextContent("150 / 300");
    const updateCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/shelters/shelter-aluva-school"));
    expect(updateCall).toBeDefined();
    const updateInit = updateCall?.[1] as RequestInit;
    const headers = new Headers(updateInit.headers);
    expect(headers.get("X-Demo-Role")).toBe("shelter_manager");
    expect(headers.get("X-Demo-User")).toBe("ops-shelter-manager");
    expect(JSON.parse(String(updateInit.body))).toMatchObject({ expected_version: 3, activation_status: "LIMITED", capacity_remaining: 150, status_reason: "Capacity verified by shelter desk" });
  });

  it("fails closed and preserves displayed shelter data when the server rejects an update", async () => {
    const user = userEvent.setup();
    installShelterApi(409);
    window.history.replaceState({}, "", "/shelters");
    renderApp();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save status" })).toBeDisabled());
    await user.selectOptions(screen.getByLabelText("Status"), "LIMITED");
    await user.clear(screen.getByLabelText("Current occupancy"));
    await user.type(screen.getByLabelText("Current occupancy"), "150");
    await user.type(screen.getByLabelText("Update reason"), "Capacity checked by operator");
    const save = screen.getByRole("button", { name: "Save status" });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);

    expect(await screen.findByText(/Shelter update not recorded.*version is 4; expected 3.*Displayed shelter data is unchanged/i)).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Aluva School Shelter/ })).toHaveTextContent("138 / 300");
    expect(screen.getByRole("row", { name: /Aluva School Shelter/ })).toHaveTextContent("OPEN");
  });

  it("shows audit integrity as valid only after an authoritative server response", async () => {
    installAuditApi();
    window.history.replaceState({}, "", "/audit");
    renderApp();

    expect(await screen.findByText("Server verified audit chain")).toBeInTheDocument();
    expect(screen.getByText("Integrity valid")).toBeInTheDocument();
    expect(screen.getByText("SHELTER STATUS UPDATED")).toBeInTheDocument();
    expect(screen.queryByText("Hash chain verified")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Audit event table" })).toHaveAttribute("tabindex", "0");
  });

  it("does not make an integrity claim when authoritative audit verification is unavailable", async () => {
    installAuditApi({ auditStatus: 503 });
    window.history.replaceState({}, "", "/audit");
    renderApp();

    expect(await screen.findByText("Audit verification unavailable")).toBeInTheDocument();
    expect(screen.getByText("Not verified")).toBeInTheDocument();
    expect(screen.queryByText("Hash chain verified")).not.toBeInTheDocument();
    expect(screen.queryByText("Integrity valid")).not.toBeInTheDocument();
  });

  it("advances and resets the deterministic replay", async () => {
    installDemoControlApi();
    const user = userEvent.setup();
    renderApp();
    const simulationStatus = screen.getByText("Simulation run").closest(".status-item");
    expect(simulationStatus).not.toBeNull();
    await waitFor(() => expect(simulationStatus).toHaveTextContent("model-demo-reset"));
    const initialVersion = "model-demo-reset";
    await user.click(screen.getByRole("button", { name: /Advance 10 min/i }));
    expect(await screen.findByText(/Authoritative estimates refreshed/i)).toBeInTheDocument();
    await waitFor(() => expect(simulationStatus).not.toHaveTextContent(initialVersion ?? ""));

    await user.selectOptions(
      screen.getByRole("combobox", { name: /Active role/i }),
      "Identity administrator",
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /Reset replay/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Reset replay/i }));
    expect(await screen.findByText(/replay reset to the judging checkpoint/i)).toBeInTheDocument();
    await waitFor(() => expect(simulationStatus).toHaveTextContent(initialVersion ?? ""));
  });
});
