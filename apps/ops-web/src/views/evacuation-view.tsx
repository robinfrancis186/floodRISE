import { FloodMap } from "@floodrise/map";
import { Button } from "@floodrise/ui";
import { AlertTriangle, Building2, CheckCircle2, Clock3, MapPin, Navigation, Route, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { DecisionDialog } from "../components/decision-dialog";
import { StatusPill } from "../components/status-pill";
import { ViewHeader } from "../components/view-header";
import { useOperations } from "../state/operations-context";

export function EvacuationView() {
  const { snapshot, horizon, setHorizon, decideAction, role } = useOperations();
  const [selectedId, setSelectedId] = useState(snapshot.routes[0].id);
  const [dialogOpen, setDialogOpen] = useState(false);
  const selected = snapshot.routes.find((route) => route.id === selectedId) ?? snapshot.routes[0];
  const action = snapshot.actions.find((item) => item.type === "EVACUATION_GUIDANCE") ?? snapshot.actions[0];
  const reviewable = action?.status === "PENDING_APPROVAL" && Boolean(action.approvalId && action.approvalVersion);
  if (!selected) return <div className="page-workspace"><ViewHeader title="Evacuation Routing" description="No compliant lower-risk route is currently available." /><section className="no-route-state"><AlertTriangle /><h3>No compliant route available</h3><p>Do not infer that unlisted roads are safe. Hold at the designated staging point and await a field update.</p><Button variant="outline"><MapPin />View staging point</Button></section></div>;
  return <div className="page-workspace evacuation-page">
    <ViewHeader title="Evacuation Routing" description="Compare lower-risk alternatives against current evidence and rapid impact estimates." actions={<><StatusPill tone="warning">Valid until {selected.valid_until.slice(11, 16)}</StatusPill><Button disabled={!reviewable} title={reviewable ? undefined : "A current authoritative approval request is required"} onClick={() => setDialogOpen(true)}><ShieldAlert />{action?.status === "APPROVED" ? "Guidance approved" : "Review guidance approval"}</Button></>} />
    <div className="evacuation-layout">
      <section className="evacuation-map"><FloodMap variant="operations" horizon={horizon} onHorizonChange={setHorizon} selectedFeatureId="route-primary" className="shared-map" height="100%" ariaLabel="Lower-risk evacuation route alternatives and shelter access" /></section>
      <section className="route-list-panel"><header><h3>Route alternatives</h3><span>Origin: Aluva–Paravur Road</span></header>
        <div className="route-list">{snapshot.routes.map((route, index) => <button key={route.id} className="route-option" data-selected={selected.id === route.id || undefined} onClick={() => setSelectedId(route.id)}>
          <span className="route-rank">{index + 1}</span><span><strong>{route.label}</strong><small><Navigation />{route.distance_km} km · <Clock3 />{route.duration_min} min</small><em>{route.shelter}</em></span><StatusPill tone={route.risk === "LOWER" ? "success" : "warning"}>{route.risk === "LOWER" ? "Lower risk" : "Elevated"}</StatusPill>
        </button>)}</div>
      </section>
      <aside className="route-detail-panel"><h3>{selected.label}</h3><p className="route-disclaimer"><AlertTriangle />This is a lower-risk route, not a guarantee of safety. Conditions can change quickly.</p>
        {action && <p className="route-disclaimer"><ShieldAlert /><span><strong>Two-person approval {action.status === "PENDING_APPROVAL" ? "pending" : action.status.toLowerCase().replaceAll("_", " ")}</strong><br />Requested by {action.requestedBy}. Active reviewer: {role}. Request {action.approvalId ?? "unavailable"} · version {action.approvalVersion ?? "unavailable"}.</span></p>}
        <div className="route-destination"><Building2 /><span><small>Destination</small><strong>{selected.shelter}</strong><em>Shelter status confirmed open</em></span></div>
        <h4>Why this route</h4><ul>{selected.reasons.map((reason) => <li key={reason}><CheckCircle2 />{reason}</li>)}</ul>
        <dl className="detail-list"><div><dt>Model version</dt><dd>{selected.model_version}</dd></div><div><dt>Evidence version</dt><dd>{selected.evidence_version}</dd></div><div><dt>Distance</dt><dd>{selected.distance_km} km</dd></div><div><dt>Estimated travel</dt><dd>{selected.duration_min} min</dd></div></dl>
        <Button variant="outline"><Route />Send to field team</Button>
      </aside>
    </div>
    <DecisionDialog open={dialogOpen} title="Approve evacuation guidance" description={`Broad evacuation guidance requires two distinct authorized people. Requester: ${action?.requestedBy ?? "unavailable"}. This decision binds approval version ${action?.approvalVersion ?? "unavailable"}, the exact route, audience, evidence, and model versions.`} confirmLabel="Approve guidance" onClose={() => setDialogOpen(false)} onConfirm={(note) => action ? decideAction(action.id, "APPROVE", note) : false} />
  </div>;
}
