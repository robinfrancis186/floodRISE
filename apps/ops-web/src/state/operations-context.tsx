import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { demoSnapshot } from "../data/demo";
import {
  advanceDemo as advanceDemoApi,
  actionStatusFromApproval,
  apiIdentityForRole,
  describeApiError,
  fetchOperationsSnapshot,
  resetDemo as resetDemoApi,
  submitApprovalDecision,
  submitShelterUpdate,
  submitSignalDecision,
  signalDecisionFromState,
  signalStatusFromState,
  API_ROOT,
} from "../lib/api";
import {
  subscribeToOperationsEvents,
  type OperationsStreamStatus,
} from "../lib/operations-events";
import type {
  OperationsSnapshot,
  SignalDecision,
  StaffRole,
} from "../lib/models";

type Horizon = "now" | "1h" | "3h";

type Notice = { id: number; tone: "success" | "warning" | "info"; message: string };

type OperationsContextValue = {
  snapshot: OperationsSnapshot;
  connected: boolean;
  streamStatus: "offline" | OperationsStreamStatus;
  loading: boolean;
  role: StaffRole;
  setRole: (role: StaffRole) => void;
  horizon: Horizon;
  setHorizon: (value: Horizon) => void;
  selectedSignalId: string;
  setSelectedSignalId: (id: string) => void;
  selectedPriorityId: string;
  setSelectedPriorityId: (id: string) => void;
  notice: Notice | null;
  decideSignal: (id: string, decision: SignalDecision, note?: string, apiId?: string, apiVersion?: number) => Promise<boolean>;
  decideAction: (id: string, decision: "APPROVE" | "MODIFY" | "REJECT", note?: string) => Promise<boolean>;
  updateShelter: (id: string, status: "OPEN" | "LIMITED" | "FULL", occupancy: number, reason: string) => Promise<boolean>;
  advanceDemo: () => void;
  resetDemo: () => void;
};

const OperationsContext = createContext<OperationsContextValue | null>(null);

export function OperationsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState<StaffRole>("Incident commander");
  const query = useQuery({
    queryKey: ["operations-bootstrap", role],
    queryFn: () => fetchOperationsSnapshot(apiIdentityForRole(role)),
  });
  const [snapshot, setSnapshot] = useState<OperationsSnapshot>(() => structuredClone(demoSnapshot));
  const [connected, setConnected] = useState(false);
  const [streamStatus, setStreamStatus] = useState<"offline" | OperationsStreamStatus>("offline");
  const [horizon, setHorizon] = useState<Horizon>("now");
  const [selectedSignalId, setSelectedSignalId] = useState("ALV-042");
  const [selectedPriorityId, setSelectedPriorityId] = useState("RES-KDG-01");
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    if (!query.data) return;
    setSnapshot(query.data.snapshot);
    setConnected(query.data.connected);
  }, [query.data]);

  useEffect(() => {
    const apiConnected = query.data?.connected ?? false;
    const incidentId = query.data?.snapshot.incidentId;
    if (!apiConnected || !incidentId) {
      setStreamStatus("offline");
      return;
    }

    let invalidationTimer: number | null = null;
    const unsubscribe = subscribeToOperationsEvents({
      apiRoot: API_ROOT,
      incidentId,
      identity: apiIdentityForRole(role),
      onStatus: setStreamStatus,
      onEvent: () => {
        if (invalidationTimer !== null) window.clearTimeout(invalidationTimer);
        invalidationTimer = window.setTimeout(() => {
          void queryClient.invalidateQueries({
            queryKey: ["operations-bootstrap", role],
            exact: true,
          });
        }, 50);
      },
    });

    return () => {
      if (invalidationTimer !== null) window.clearTimeout(invalidationTimer);
      unsubscribe();
    };
  }, [query.data?.connected, query.data?.snapshot.incidentId, queryClient, role]);

  const announce = useCallback((message: string, tone: Notice["tone"] = "info") => {
    const id = Date.now();
    setNotice({ id, tone, message });
    window.setTimeout(() => setNotice((current) => current?.id === id ? null : current), 4_000);
  }, []);

  const decideSignal = useCallback(async (id: string, decision: SignalDecision, note = "", apiId?: string, apiVersion?: number) => {
    if (!(["Incident commander", "Verifier", "Field responder"] as StaffRole[]).includes(role)) {
      announce(`${role} does not have permission to decide FloodSignal evidence.`, "warning");
      return false;
    }
    const signal = snapshot.signals.find((candidate) => candidate.id === id);
    const authoritativeId = apiId ?? signal?.apiId;
    const expectedVersion = apiVersion ?? signal?.apiVersion;
    if (!connected || !authoritativeId || !expectedVersion) {
      announce(
        "FloodSignal decision not recorded. The authoritative signal version is unavailable; reconnect and refresh before deciding.",
        "warning",
      );
      return false;
    }
    const copy = decision === "VERIFIED"
      ? "Community corroboration recorded — not an official confirmation."
      : decision === "FIELD_CHECK"
        ? "Field verification requested and written to the audit trail."
        : "Cluster rejected; evidence remains preserved in the audit trail.";
    try {
      const updated = await submitSignalDecision(
        authoritativeId,
        decision,
        note || copy,
        expectedVersion,
        apiIdentityForRole(role),
      );
      setSnapshot((current) => ({
        ...current,
        signals: current.signals.map((candidate) => candidate.id === id ? {
          ...candidate,
          apiVersion: updated.version,
          decision: signalDecisionFromState(
            updated.state,
            updated.human_review?.decision ?? updated.human_decision ?? undefined,
          ),
          status: signalStatusFromState(updated.state),
        } : candidate),
      }));
      announce(copy, decision === "REJECTED" ? "warning" : "success");
      return true;
    } catch (error) {
      announce(`FloodSignal decision not recorded. ${describeApiError(error)} Evidence remains unchanged.`, "warning");
      return false;
    }
  }, [announce, connected, role, snapshot.signals]);

  const decideAction = useCallback(async (id: string, decision: "APPROVE" | "MODIFY" | "REJECT", note = "") => {
    if (!(["Incident commander", "Verifier", "Field responder"] as StaffRole[]).includes(role)) {
      announce("This role cannot approve operational actions. Switch to an authorized approver.", "warning");
      return false;
    }
    const action = snapshot.actions.find((candidate) => candidate.id === id);
    if (!action?.approvalId || !action.approvalVersion) {
      announce(
        "Approval not recorded. The authoritative approval request is unavailable; reconnect and refresh before deciding.",
        "warning",
      );
      return false;
    }
    const verb = decision === "APPROVE" ? "approved" : decision === "MODIFY" ? "returned for changes" : "rejected";
    try {
      const response = await submitApprovalDecision(
        action.approvalId,
        decision,
        note || `Action ${verb}`,
        action.approvalVersion,
        apiIdentityForRole(role),
      );
      setSnapshot((current) => ({
        ...current,
        actions: current.actions.map((candidate) => candidate.id === id ? {
          ...candidate,
          approvalVersion: response.approval.version,
          status: actionStatusFromApproval(response.approval.status),
          detail: note || candidate.detail,
          decidedById: response.approval.decided_by ?? apiIdentityForRole(role).userId,
          decisionReason: response.approval.decision_reason ?? (note || `Action ${verb}`),
          executionStatus: response.approval.execution_status,
        } : candidate),
      }));
      announce(`Action ${verb}. The server recorded the decision and bound versions.`, decision === "REJECT" ? "warning" : "success");
      return true;
    } catch (error) {
      announce(`Approval not recorded. ${describeApiError(error)} The action remains pending.`, "warning");
      return false;
    }
  }, [announce, role, snapshot.actions]);

  const updateShelter = useCallback(async (id: string, status: "OPEN" | "LIMITED" | "FULL", occupancy: number, reason: string) => {
    if (!(role === "Shelter manager" || role === "Incident commander")) {
      announce("Switch to shelter manager or incident commander to update shelter status.", "warning");
      return false;
    }
    const shelter = snapshot.shelters.find((candidate) => candidate.id === id);
    if (!connected || !shelter?.apiId || !shelter.apiVersion) {
      announce("Shelter update not recorded. The authoritative shelter version is unavailable; reconnect and refresh before saving.", "warning");
      return false;
    }
    try {
      const updated = await submitShelterUpdate(
        shelter,
        status,
        Math.min(shelter.capacity, Math.max(0, occupancy)),
        reason,
        apiIdentityForRole(role),
      );
      const capacity = updated.capacity_total ?? updated.capacity ?? shelter.capacity;
      const confirmedOccupancy = updated.occupancy
        ?? (updated.capacity_remaining === undefined ? occupancy : Math.max(0, capacity - updated.capacity_remaining));
      setSnapshot((current) => ({
        ...current,
        shelters: current.shelters.map((candidate) => candidate.id === id ? {
          ...candidate,
          apiVersion: updated.version,
          status: updated.activation_status === "OPEN" || updated.activation_status === "LIMITED" || updated.activation_status === "FULL" ? updated.activation_status : candidate.status,
          occupancy: confirmedOccupancy,
          capacity,
          access: updated.access_status === "REACHABLE" ? "Reachable" : updated.access_status === "AT_RISK" || updated.access_status === "RISKY" ? "At risk" : updated.access_status === "UNKNOWN" ? "Unknown" : candidate.access,
          updatedMinutesAgo: 0,
        } : candidate),
      }));
      announce("Shelter status confirmed by the server. The authoritative record and audit event were committed together.", "success");
      return true;
    } catch (error) {
      announce(`Shelter update not recorded. ${describeApiError(error)} Displayed shelter data is unchanged.`, "warning");
      return false;
    }
  }, [announce, connected, role, snapshot.shelters]);

  const advanceDemo = useCallback(() => {
    if (role !== "Incident commander" && role !== "Resilience engineer") {
      announce("Only an incident commander or resilience engineer can advance demo evidence.", "warning");
      return;
    }
    if (!connected) {
      announce("Scenario was not advanced. Reconnect to the authoritative demo API first.", "warning");
      return;
    }
    void (async () => {
      try {
        await advanceDemoApi(10, apiIdentityForRole(role));
        await queryClient.invalidateQueries({
          queryKey: ["operations-bootstrap", role],
          exact: true,
        });
        announce("Scenario advanced 10 minutes. Authoritative estimates refreshed.", "success");
      } catch (error) {
        announce(`Scenario was not advanced. ${describeApiError(error)}`, "warning");
      }
    })();
  }, [announce, connected, queryClient, role]);

  const resetDemo = useCallback(() => {
    if (role !== "Identity administrator") {
      announce("Only an identity administrator can reset the deterministic replay.", "warning");
      return;
    }
    if (!connected) {
      announce("Replay was not reset. Reconnect to the authoritative demo API first.", "warning");
      return;
    }
    void (async () => {
      try {
        await resetDemoApi(apiIdentityForRole(role));
        setHorizon("now");
        setSelectedSignalId("ALV-042");
        setSelectedPriorityId("RES-KDG-01");
        await queryClient.invalidateQueries({
          queryKey: ["operations-bootstrap", role],
          exact: true,
        });
        announce("Kerala extreme-rainfall replay reset to the judging checkpoint.", "success");
      } catch (error) {
        announce(`Replay was not reset. ${describeApiError(error)}`, "warning");
      }
    })();
  }, [announce, connected, queryClient, role]);

  const value = useMemo<OperationsContextValue>(() => ({
    snapshot,
    connected,
    streamStatus,
    loading: query.isLoading,
    role,
    setRole,
    horizon,
    setHorizon,
    selectedSignalId,
    setSelectedSignalId,
    selectedPriorityId,
    setSelectedPriorityId,
    notice,
    decideSignal,
    decideAction,
    updateShelter,
    advanceDemo,
    resetDemo,
  }), [snapshot, connected, streamStatus, query.isLoading, role, horizon, selectedSignalId, selectedPriorityId, notice, decideSignal, decideAction, updateShelter, advanceDemo, resetDemo]);

  return <OperationsContext.Provider value={value}>{children}</OperationsContext.Provider>;
}

export function useOperations() {
  const value = useContext(OperationsContext);
  if (!value) throw new Error("useOperations must be used within OperationsProvider");
  return value;
}
