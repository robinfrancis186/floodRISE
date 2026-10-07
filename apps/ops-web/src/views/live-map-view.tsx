import { FloodMap, type FloodMapSelection } from "@floodrise/map";
import { Badge, Button } from "@floodrise/ui";
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  ChevronRight,
  CircleDot,
  CloudRain,
  FileCheck2,
  GitCompareArrows,
  Layers3,
  MapPin,
  Navigation,
  Route,
  ShieldAlert,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";
import { DecisionDialog } from "../components/decision-dialog";
import { Confidence, StatusPill } from "../components/status-pill";
import type { ViewId } from "../lib/models";
import { useOperations } from "../state/operations-context";

export function LiveMapView({ onNavigate }: { onNavigate: (view: ViewId) => void }) {
  const { snapshot, connected, horizon, setHorizon, selectedSignalId, setSelectedSignalId, requestApproval, decideAction, role } = useOperations();
  const selected = snapshot.signals.find((signal) => signal.id === selectedSignalId) ?? snapshot.signals[0];
  const action = snapshot.actions[0];
  const reviewable = action.status === "PENDING_APPROVAL" && Boolean(action.approvalId && action.approvalVersion);
  const [decision, setDecision] = useState<"APPROVE" | "MODIFY" | "REJECT" | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const canRequest = connected && action.status === "RECOMMENDED" && !action.approvalId && ["Incident commander", "Field responder", "Resilience engineer"].includes(role);
  const [baseline, setBaseline] = useState<"chennai" | "kerala">("chennai");
  const [listOpen, setListOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const scenarioTime = new Date(snapshot.scenarioTime).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
  const confidenceReason = useMemo(() => [
    { icon: CloudRain, label: "Rainfall increase", value: "118 mm (3h)" },
    { icon: GitCompareArrows, label: "Rapid impact estimate", value: "Higher runoff" },
    { icon: Users, label: `${selected.independentReports} independent ground reports`, value: "3–8 min ago" },
  ], [selected.independentReports]);
  const mapFeatureId = selected.id === "VEL-042" ? "cluster-velachery" : selected.id === "SAI-018" ? "cluster-saidapet" : selected.id === "PAL-031" ? "cluster-pallikaranai" : null;
  const handleMapSelection = (selection: FloodMapSelection) => {
    if (selection.kind !== "cluster") return;
    const match = snapshot.signals.find((signal) => selection.name.includes(signal.id) || selection.name.toLowerCase().includes(signal.name.toLowerCase()));
    if (match) setSelectedSignalId(match.id);
  };

  return (
    <div className="workspace live-workspace">
      {baseline === "chennai" && <div className="change-alert" role="status">
        <AlertTriangle aria-hidden />
        <span className="change-alert-label">Replay update</span>
        <strong>Velachery flood estimate updated</strong>
        <span className="change-alert-detail">{selected.independentReports} independent reports · scenario {scenarioTime} IST</span>
        <Button size="sm" onClick={() => onNavigate("signals")}>Review</Button>
      </div>}
      {baseline === "kerala" && <div className="change-alert" role="status"><MapPin aria-hidden /><strong>OpenStreetMap facility baseline</strong><span className="change-alert-detail">Geographic locations · availability unverified</span></div>}

      <div className="map-toolbar" role="group" aria-label="Flood map controls">
        <span className="map-toolbar-title"><CircleDot aria-hidden />{baseline === "kerala" ? "Kerala mapped facilities" : "Flood estimate"}</span>
        {baseline === "chennai" && <div className="map-horizon-inline" role="group" aria-label="Forecast horizon">
          {(["now", "1h", "3h"] as const).map((value) => <button key={value} type="button" aria-pressed={horizon === value} onClick={() => setHorizon(value)}>{value === "now" ? "Now" : `+${value}`}</button>)}
        </div>}
        {baseline === "chennai" && <Button className="map-key-toggle" variant="outline" size="sm" aria-expanded={legendOpen} onClick={() => setLegendOpen((open) => { if (!open) setListOpen(false); return !open; })}><Layers3 aria-hidden />Key</Button>}
        {baseline === "chennai" && <Button className="map-list-toggle" variant="outline" size="sm" aria-expanded={listOpen} aria-label={`${listOpen ? "Hide" : "Show"} report cluster list`} onClick={() => setListOpen((open) => { if (!open) setLegendOpen(false); return !open; })}><FileCheck2 aria-hidden />{listOpen ? "Hide" : "Show"} clusters</Button>}
      </div>
      <section className="map-pane live-map-pane" aria-label="Flood impact map">
        <FloodMap
          variant="operations"
          allowRegionSwitch
          onBaselineChange={(region) => { setBaseline(region); setListOpen(false); setLegendOpen(false); }}
          horizon={horizon}
          onHorizonChange={setHorizon}
          selectedFeatureId={mapFeatureId}
          onFeatureSelect={handleMapSelection}
          showSummary={false}
          showLegend={legendOpen}
          showHorizonControl={false}
          showDemoLabel={false}
          freshnessLabel={`Scenario time ${scenarioTime} IST`}
          className="shared-map"
          height="100%"
          ariaLabel="Chennai current flooding, predicted flooding, routes and shelters"
        />
        {listOpen && <div className="map-list-alternative">
          <h3>Report clusters</h3>
          <ul>
            {snapshot.signals.slice(0, 4).map((signal) => <li key={signal.id}><button onClick={() => setSelectedSignalId(signal.id)}><MapPin aria-hidden /><span><strong>{signal.name}</strong><small>{signal.status.replaceAll("_", " ")} · {signal.confidence}%</small></span><ChevronRight aria-hidden /></button></li>)}
          </ul>
        </div>}
      </section>

      {baseline === "chennai" ? <aside className="inspector live-inspector" aria-label="Selected cluster details">
        <div className="inspector-title-row">
          <div><h2>{selected.name} Cluster <span>{selected.id}</span></h2><div className="inline-status"><StatusPill tone="danger">Severe</StatusPill><Confidence value={selected.confidence} /><span>{selected.updatedMinutesAgo} min ago</span></div></div>
        </div>

        <section className="inspector-section">
          <h3>Impact</h3>
          <div className="impact-strip">
            <Metric icon={Users} value={selected.peopleExposed.toLocaleString("en-IN")} label="People likely impacted" />
            <Metric icon={Route} value={selected.roadsAtRisk} label="Roads at risk" />
            <Metric icon={Building2} value={selected.sheltersReachable} label="Shelters reachable" />
          </div>
        </section>

        <section className="inspector-section inspector-details-list">
          <details>
            <summary><span><strong>Why this estimate</strong><small>Rain, model, and field evidence</small></span></summary>
            <div className="reason-list">{confidenceReason.map(({ icon: Icon, label, value }, index) => <button key={label} type="button" onClick={() => onNavigate(index === 0 ? "sources" : index === 1 ? "resilience" : "signals")}><Icon aria-hidden /><span>{label}</span><small>{value}</small><ChevronRight aria-hidden /></button>)}</div>
          </details>
        </section>

        <section className="inspector-section inspector-details-list">
          <details>
            <summary><span><strong>Ground reports</strong><small>{selected.receivedReports} reports · {selected.independentReports} independent</small></span></summary>
            <div className="section-heading-inline"><span>Evidence in this scenario</span><Button variant="link" onClick={() => onNavigate("signals")}>Review all</Button></div>
            <ul className="evidence-summary-list">
              {selected.evidence.slice(0, 5).map((report) => <li key={report.id}><FileCheck2 aria-hidden /><span>{report.note}</span><small>{report.source}</small><time>{report.observedAt}</time></li>)}
            </ul>
          </details>
        </section>

        <section className="recommended-action">
          <div><ShieldAlert aria-hidden /><span><strong>Scenario recommendation</strong><small>{action.detail}</small></span></div>
          <div className="version-binding"><span>Evidence {action.evidenceVersion}</span><span>Model {action.modelVersion}</span></div>
          <p><strong>Two-person approval</strong><span>{reviewable ? `Request v${action.approvalVersion} · a different reviewer is required` : action.status === "RECOMMENDED" ? "No request yet · another reviewer is required" : "No active approval request"}</span></p>
          {reviewable ? <div className="decision-buttons">
            <Button onClick={() => setDecision("APPROVE")}>Approve action</Button>
            <Button variant="outline" onClick={() => setDecision("MODIFY")}>Modify</Button>
            <Button variant="destructive-outline" onClick={() => setDecision("REJECT")}>Reject</Button>
          </div> : <Button className="request-approval-button" variant="outline" disabled={!canRequest} title={canRequest ? undefined : "Connect to the authorized API and use an allowed requester role"} onClick={() => setRequestOpen(true)}>Request second-person review</Button>}
        </section>
      </aside> : <aside className="inspector live-inspector" aria-label="Kerala facility map information"><div className="inspector-title-row"><h2>Kerala location baseline</h2></div><section className="inspector-section"><p>Use Places to search and select hospitals, police, fire stations, schools, colleges, or community centres.</p><p>Locations are community-mapped. Opening status, access, capacity, and shelter activation are unverified. No Kerala flood estimate or evacuation guidance is available.</p></section></aside>}

      <DecisionDialog
        open={decision !== null}
        title={decision === "APPROVE" ? "Approve operational action" : decision === "MODIFY" ? "Modify operational action" : "Reject operational action"}
        description="This decision is bound to the displayed evidence and model versions. Official actions require authorized human approval."
        confirmLabel={decision === "APPROVE" ? "Approve action" : decision === "MODIFY" ? "Save modifications" : "Reject action"}
        destructive={decision === "REJECT"}
        requireNote={decision !== "APPROVE"}
        onClose={() => setDecision(null)}
        onConfirm={(note) => decision ? decideAction(action.id, decision, note) : false}
      />
      <DecisionDialog
        open={requestOpen}
        title="Request second-person review"
        description="This records an approval request for a different authorized reviewer. It does not publish or send an alert."
        confirmLabel="Submit review request"
        requireNote
        onClose={() => setRequestOpen(false)}
        onConfirm={(reason) => requestApproval(action.id, reason)}
      />
    </div>
  );
}

function Metric({ icon: Icon, value, label }: { icon: typeof Users; value: string | number; label: string }) {
  return <div><Icon aria-hidden /><strong>{value}</strong><small>{label}</small></div>;
}
