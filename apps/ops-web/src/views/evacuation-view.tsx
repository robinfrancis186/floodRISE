import { FloodMap } from "@floodrise/map";
import { Button } from "@floodrise/ui";
import { AlertTriangle, Building2, CheckCircle2, Clock3, MapPin, Navigation, Route, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DecisionDialog } from "../components/decision-dialog";
import { StatusPill } from "../components/status-pill";
import { ViewHeader } from "../components/view-header";
import type { OperationsSnapshot, ShelterRecord } from "../lib/models";
import { useOperations } from "../state/operations-context";

type RouteRecord = OperationsSnapshot["routes"][number];
type DestinationRecord = Pick<ShelterRecord, "name" | "status" | "access" | "updatedMinutesAgo"> & {
  source: "CURRENT_SHELTER" | "ROUTE_SNAPSHOT";
  warnings: string[];
};

function resolveDestination(
  route: RouteRecord,
  shelters: ShelterRecord[],
): DestinationRecord | null {
  const routeShelterId = route.shelter_id?.trim();
  const routeShelterName = route.shelter.trim().toLocaleLowerCase();
  const currentShelter = routeShelterId
    ? shelters.find((shelter) => shelter.apiId === routeShelterId)
    : shelters.find((shelter) => (
      Boolean(shelter.apiId) && shelter.name.trim().toLocaleLowerCase() === routeShelterName
    ));
  if (currentShelter) {
    return {
      name: currentShelter.name,
      status: currentShelter.status,
      access: currentShelter.access,
      updatedMinutesAgo: currentShelter.updatedMinutesAgo,
      source: "CURRENT_SHELTER",
      warnings: [],
    };
  }

  const detail = route.shelter_detail;
  const detailMatches = detail && (
    routeShelterId
      ? detail.id === routeShelterId
      : detail.name.trim().toLocaleLowerCase() === routeShelterName
  );
  if (!detailMatches || !detail.status || !detail.access) return null;
  return {
    name: detail.name,
    status: detail.status,
    access: detail.access,
    updatedMinutesAgo: detail.updated_minutes_ago ?? -1,
    source: "ROUTE_SNAPSHOT",
    warnings: detail.warnings ?? [],
  };
}

function destinationIsUsable(destination: DestinationRecord | null): boolean {
  if (!destination) return true;
  return (
    (destination.status === "OPEN" || destination.status === "LIMITED")
    && destination.access === "Reachable"
  );
}

function destinationSummary(destination: DestinationRecord | null): string {
  if (!destination) return "Status unverified";
  return `${destination.status} · ${destination.access}`;
}

function formatIstClock(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "unavailable";
  return timestamp.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}

export function EvacuationView() {
  const { snapshot, mode, horizon, setHorizon, decideAction, role } = useOperations();
  const routeEntries = useMemo(() => snapshot.routes
    .map((route) => ({ route, destination: resolveDestination(route, snapshot.shelters) }))
    .filter(({ destination }) => destinationIsUsable(destination)), [snapshot.routes, snapshot.shelters]);
  const withheldRouteCount = snapshot.routes.length - routeEntries.length;
  const [selectedId, setSelectedId] = useState(routeEntries[0]?.route.id ?? "");
  const [dialogOpen, setDialogOpen] = useState(false);
  const selectedEntry = routeEntries.find(({ route }) => route.id === selectedId) ?? routeEntries[0];
  const selected = selectedEntry?.route;
  const selectedDestination = selectedEntry?.destination ?? null;
  const action = snapshot.actions.find((item) => item.type === "EVACUATION_GUIDANCE") ?? snapshot.actions[0];
  const destinationVerified = Boolean(
    selectedDestination
    && selectedDestination.status !== "FULL"
    && selectedDestination.access === "Reachable",
  );
  const reviewable = action?.status === "PENDING_APPROVAL"
    && Boolean(action.approvalId && action.approvalVersion)
    && destinationVerified;
  const reviewUnavailableReason = !destinationVerified
    ? "Current authoritative shelter status and reachable access are required before evacuation guidance can be approved."
    : "A current authoritative approval request is required.";
  useEffect(() => {
    if (!routeEntries.some(({ route }) => route.id === selectedId)) {
      setSelectedId(routeEntries[0]?.route.id ?? "");
    }
  }, [routeEntries, selectedId]);
  if (!selected) {
    return <NoRouteState showDemoStagingPoint={mode === "demo"} reason={withheldRouteCount > 0
      ? "Every current alternative leads to a shelter recorded as full or not reachable. Await a newly calculated route or responder direction."
      : undefined} />;
  }
  return <div className="page-workspace evacuation-page">
    <ViewHeader title="Evacuation Routing" description="Compare lower-risk alternatives against current evidence and rapid impact estimates." actions={<><StatusPill tone="warning">Valid until {formatIstClock(selected.valid_until)} IST</StatusPill><Button disabled={!reviewable} title={reviewable ? undefined : reviewUnavailableReason} onClick={() => setDialogOpen(true)}><ShieldAlert />{action?.status === "APPROVED" ? "Guidance approved" : "Review guidance approval"}</Button></>} />
    <div className="evacuation-layout">
      <section className="evacuation-map">
        {mode === "demo"
          ? <FloodMap variant="operations" horizon={horizon} onHorizonChange={setHorizon} selectedFeatureId={null} showRouteGeometry={false} cooperativeGestures className="shared-map" height="100%" ariaLabel="Flood and shelter context map; route geometry is not displayed" />
          : <div className="empty-state authoritative-map-empty" role="status"><Navigation /><strong>Authoritative route geometry unavailable</strong><span>Use the versioned alternatives below. No replay route or flood overlay is shown.</span></div>}
        <p className="evacuation-map-boundary" role="note">Route geometry is not displayed because the authoritative alternatives do not include matching GeoJSON. Use the versioned route list; do not infer a path from this context map.</p>
      </section>
      <section className="route-list-panel"><header><h3>Route alternatives</h3><span>{mode === "demo" ? "Origin: Aluva–Paravur Road" : "Origin: unavailable in route response"}</span></header>
        {withheldRouteCount > 0 && <p className="route-withheld-note" role="status"><AlertTriangle />{withheldRouteCount} alternative{withheldRouteCount === 1 ? "" : "s"} withheld because the linked shelter is full or not currently reachable.</p>}
        <div className="route-list">{routeEntries.map(({ route, destination }, index) => <button key={route.id} className="route-option" data-selected={selected.id === route.id || undefined} onClick={() => setSelectedId(route.id)}>
          <span className="route-rank">{index + 1}</span><span><strong>{route.label}</strong><small><Navigation />{route.distance_km} km · <Clock3 />{route.duration_min} min</small><em>{route.shelter} · {destinationSummary(destination)}</em></span><StatusPill tone={route.risk === "LOWER" ? "success" : "warning"}>{route.risk === "LOWER" ? "Lower risk" : "Elevated"}</StatusPill>
        </button>)}</div>
      </section>
      <aside className="route-detail-panel"><h3>{selected.label}</h3><p className="route-disclaimer"><AlertTriangle />This is a lower-risk route, not a guarantee of safety. Conditions can change quickly.</p>
        {action && <p className="route-disclaimer"><ShieldAlert /><span><strong>Two-person approval {action.status === "PENDING_APPROVAL" ? "pending" : action.status.toLowerCase().replaceAll("_", " ")}</strong><br />Requested by {action.requestedBy}. Active reviewer: {role}. Request {action.approvalId ?? "unavailable"} · version {action.approvalVersion ?? "unavailable"}.</span></p>}
        <div className="route-destination" data-verified={selectedDestination ? "true" : "false"}><Building2 /><span><small>Destination</small><strong>{selected.shelter}</strong>{selectedDestination
          ? <em>Shelter record: {selectedDestination.status} · {selectedDestination.access} · {selectedDestination.updatedMinutesAgo !== null && selectedDestination.updatedMinutesAgo >= 0 ? `updated ${selectedDestination.updatedMinutesAgo} min ago` : "freshness unavailable"}</em>
          : <em>Shelter status unverified; confirm with the shelter desk before movement.</em>}</span></div>
        {selectedDestination?.source === "ROUTE_SNAPSHOT" && <p className="route-shelter-note">Status comes from the route’s bound shelter snapshot; recheck it before dispatch.</p>}
        {selectedDestination?.warnings.map((warning) => <p key={warning} className="route-shelter-note"><AlertTriangle />Shelter warning: {warning.toLowerCase().replaceAll("_", " ")}</p>)}
        <h4>Why this route</h4><ul>{selected.reasons.map((reason) => <li key={reason}><CheckCircle2 />{reason}</li>)}</ul>
        <dl className="detail-list"><div><dt>Model version</dt><dd>{selected.model_version}</dd></div><div><dt>Evidence version</dt><dd>{selected.evidence_version}</dd></div><div><dt>Distance</dt><dd>{selected.distance_km} km</dd></div><div><dt>Estimated travel</dt><dd>{selected.duration_min} min</dd></div></dl>
        <Button variant="outline" disabled title={mode === "demo" ? "Field dispatch requires an approved external gateway and is unavailable in this deterministic demo." : "Field dispatch requires an approved external gateway that is not connected for this authority session."} aria-describedby="field-dispatch-boundary"><Route />Send to field team</Button>
        <p id="field-dispatch-boundary" className="workflow-boundary">{mode === "demo" ? "Field dispatch is unavailable in demo mode." : "Field dispatch is unavailable for this authority session."} Exported or displayed routes are lower-risk estimates only and must not be treated as official instructions.</p>
      </aside>
    </div>
    <DecisionDialog open={dialogOpen} title="Approve evacuation guidance" description={`Broad evacuation guidance requires two distinct authorized people. Requester: ${action?.requestedBy ?? "unavailable"}. This decision binds approval version ${action?.approvalVersion ?? "unavailable"}, the exact route, audience, evidence, and model versions.`} confirmLabel="Approve guidance" onClose={() => setDialogOpen(false)} onConfirm={(note) => action ? decideAction(action.id, "APPROVE", note) : false} />
  </div>;
}

export function NoRouteState({
  reason,
  showDemoStagingPoint = true,
}: {
  reason?: string;
  showDemoStagingPoint?: boolean;
} = {}) {
  const [showStagingPoint, setShowStagingPoint] = useState(false);
  return <div className="page-workspace">
    <ViewHeader title="Evacuation Routing" description="No compliant lower-risk route is currently available." />
    <section className="no-route-state">
      <AlertTriangle />
      <h3>No compliant route available</h3>
      <p>{reason ?? (showDemoStagingPoint
        ? "Do not infer that unlisted roads are safe. Hold at the designated staging point and await a field update."
        : "Do not infer that unlisted roads are safe. No authoritative staging point was supplied; await responder direction.")}</p>
      {showDemoStagingPoint ? <Button variant="outline" aria-expanded={showStagingPoint} aria-controls="staging-point-details" onClick={() => setShowStagingPoint((visible) => !visible)}><MapPin />{showStagingPoint ? "Hide staging point" : "View staging point"}</Button> : null}
      {showDemoStagingPoint && showStagingPoint && <div id="staging-point-details" className="staging-point-details" role="status"><strong>Aluva Fire &amp; Rescue Station forecourt</strong><span>Staging reference STG-ALV-01 · confirm local access with field command before moving.</span></div>}
    </section>
  </div>;
}
