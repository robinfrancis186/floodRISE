import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("@floodrise/map", () => ({
  FloodMap: ({ ariaLabel }: { ariaLabel?: string }) => <div data-testid="flood-map" aria-label={ariaLabel}>Deterministic Chennai map</div>,
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

function installApprovalApi(decisionStatus = 200) {
  const approvals = [
    {
      id: "approval-area-demo",
      action_type: "AREA_CAUTION",
      action_payload: { presentation_id: "ACT-204", title: "Issue area caution and reroute teams", body: "Issue an opt-in caution." },
      audience: "Velachery hazard footprint + 1 km",
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
    if (url.endsWith("/incidents")) return jsonResponse({ items: [{ id: "inc-demo-michaung-2023" }] });
    if (url.includes("/incidents/inc-demo-michaung-2023/bootstrap")) {
      return jsonResponse({
        scenario_clock: "2023-12-04T14:10:00Z",
        simulation: { model_version: "model-demo-001" },
        approvals,
        signals: [],
        reports: [],
      });
    }
    if (url.includes("/approvals/approval-evacuation-demo/decisions")) {
      if (decisionStatus >= 400) {
        return jsonResponse({
          title: "Version conflict",
          detail: "Approval version is 8; expected 7",
          code: "VERSION_CONFLICT",
        }, decisionStatus);
      }
      return jsonResponse({
        approval: {
          id: "approval-evacuation-demo",
          status: "APPROVED",
          version: 8,
          decided_by: "ops-verifier",
          decision_reason: "Independent review complete",
          execution_status: "SUCCEEDED",
        },
        alert: { id: "alert-approval-evacuation-demo" },
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
    if (url.endsWith("/incidents")) return jsonResponse({ items: [{ id: "inc-demo-michaung-2023" }] });
    if (url.includes("/incidents/inc-demo-michaung-2023/bootstrap")) {
      return jsonResponse({
        scenario_clock: "2023-12-04T14:10:00Z",
        simulation: { model_version: "model-demo-001" },
        approvals: [],
        signals: [{
          id: "signal-velachery",
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
    if (url.includes("/signals/signal-velachery/decisions")) {
      if (decisionStatus >= 400) {
        return jsonResponse({
          title: "Version conflict",
          detail: "Signal version is 5; expected 4",
          code: "VERSION_CONFLICT",
        }, decisionStatus);
      }
      return jsonResponse({
        id: "signal-velachery",
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
    if (url.endsWith("/incidents")) return jsonResponse({ items: [{ id: "inc-demo-michaung-2023" }] });
    if (url.includes("/incidents/inc-demo-michaung-2023/bootstrap")) {
      return jsonResponse({
        scenario_clock: "2023-12-04T14:10:00Z",
        simulation: { model_version: "model-demo-001" },
        approvals: [],
        signals: [],
        reports: [],
        shelters: [{
          id: "shelter-velachery-school",
          name: "Velachery School Shelter",
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
    if (url.includes("/shelters/shelter-velachery-school")) {
      if (updateStatus >= 400) {
        return jsonResponse({
          title: "Version conflict",
          detail: "Shelter version is 4; expected 3",
          code: "VERSION_CONFLICT",
        }, updateStatus);
      }
      const body = JSON.parse(String(init?.body));
      return jsonResponse({
        id: "shelter-velachery-school",
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
    if (url.endsWith("/incidents")) return jsonResponse({ items: [{ id: "inc-demo-michaung-2023" }] });
    if (url.includes("/incidents/inc-demo-michaung-2023/bootstrap")) {
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
          aggregate_id: "shelter-velachery-school",
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
    if (url.endsWith("/incidents")) return jsonResponse({ items: [{ id: "inc-demo-michaung-2023" }] });
    if (url.includes("/incidents/inc-demo-michaung-2023/bootstrap")) {
      bootstrapRequests += 1;
      return jsonResponse({
        scenario_clock: "2023-12-04T14:10:00Z",
        simulation: { model_version: `model-demo-${bootstrapRequests}` },
        approvals: [],
        signals: [],
        reports: [],
      });
    }
    if (url.endsWith("/events")) {
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
        incident_id: "inc-demo-michaung-2023",
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
      return jsonResponse({ items: [{ id: "inc-demo-michaung-2023" }] });
    }
    if (url.includes("/incidents/inc-demo-michaung-2023/bootstrap")) {
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
    if (url.endsWith("/events")) {
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
    expect(window.localStorage.getItem("floodrise.ops.events.cursor.inc-demo-michaung-2023")).toBe("12");

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
    expect(screen.getByRole("complementary", { name: /Velachery evidence review/i })).toBeInTheDocument();
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
    expect(screen.getByRole("dialog", { name: "Approve evacuation guidance" })).toBeInTheDocument();
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
    expect(screen.getByRole("row", { name: /Velachery School Shelter/ })).toHaveTextContent("150 / 300");
    const updateCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/shelters/shelter-velachery-school"));
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
    expect(screen.getByRole("row", { name: /Velachery School Shelter/ })).toHaveTextContent("138 / 300");
    expect(screen.getByRole("row", { name: /Velachery School Shelter/ })).toHaveTextContent("OPEN");
  });

  it("shows audit integrity as valid only after an authoritative server response", async () => {
    installAuditApi();
    window.history.replaceState({}, "", "/audit");
    renderApp();

    expect(await screen.findByText("Server verified audit chain")).toBeInTheDocument();
    expect(screen.getByText("Integrity valid")).toBeInTheDocument();
    expect(screen.getByText("SHELTER STATUS UPDATED")).toBeInTheDocument();
    expect(screen.queryByText("Hash chain verified")).not.toBeInTheDocument();
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
