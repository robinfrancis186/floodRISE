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
  const { snapshot, horizon, setHorizon, selectedSignalId, setSelectedSignalId, decideAction, role } = useOperations();
  const selected = snapshot.signals.find((signal) => signal.id === selectedSignalId) ?? snapshot.signals[0];
  const action = snapshot.actions[0];
  const reviewable = action.status === "PENDING_APPROVAL" && Boolean(action.approvalId && action.approvalVersion);
  const [decision, setDecision] = useState<"APPROVE" | "MODIFY" | "REJECT" | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const confidenceReason = useMemo(() => [
    { icon: CloudRain, label: "Rainfall increase", value: "118 mm (3h)" },
    { icon: GitCompareArrows, label: "Rapid impact estimate", value: "Higher runoff" },
    { icon: Users, label: `${selected.independentReports} independent ground reports`, value: "3–8 min ago" },
  ], [selected.independentReports]);
  const mapFeatureId = selected.id === "ALV-042" ? "cluster-aluva" : selected.id === "ELO-018" ? "cluster-eloor" : selected.id === "KDG-031" ? "cluster-kadungalloor" : null;
  const handleMapSelection = (selection: FloodMapSelection) => {
    if (selection.kind !== "cluster") return;
    const match = snapshot.signals.find((signal) => selection.name.includes(signal.id) || selection.name.toLowerCase().includes(signal.name.toLowerCase()));
    if (match) setSelectedSignalId(match.id);
  };

  return (
    <div className="workspace live-workspace">
      <div className="change-alert" role="status">
        <AlertTriangle aria-hidden />
        <strong>Flood extent increased near Aluva</strong>
        <span>•</span><span>{selected.independentReports} independent reports</span><span>•</span><span>2 routes affected</span>
        <Button size="sm" onClick={() => onNavigate("signals")}>Review evidence</Button>
      </div>

      <section className="map-pane live-map-pane" aria-label="Flood impact map">
        <div className="map-floating-heading">
          <span><CircleDot aria-hidden />Current + predicted flooding</span>
          <StatusPill tone="info">Rapid impact estimate</StatusPill>
        </div>
        <FloodMap
          variant="operations"
          horizon={horizon}
          onHorizonChange={setHorizon}
          selectedFeatureId={mapFeatureId}
          onFeatureSelect={handleMapSelection}
          showHorizonControl={false}
          className="shared-map"
          height="100%"
          ariaLabel="Kerala current flooding, predicted flooding, routes and shelters"
        />
        <div className="map-horizon" role="group" aria-label="Forecast horizon">
          {(["now", "1h", "3h"] as const).map((item) => <button key={item} type="button" data-active={horizon === item || undefined} onClick={() => setHorizon(item)}>{item === "now" ? "Now" : `+${item}`}</button>)}
          <span><span style={{ width: horizon === "now" ? "12%" : horizon === "1h" ? "52%" : "100%" }} /></span>
        </div>
        <button className="map-list-toggle" type="button" onClick={() => setListOpen((open) => !open)} aria-expanded={listOpen}><FileCheck2 aria-hidden />{listOpen ? "Hide" : "Show"} accessible map list</button>
        {listOpen && <div className="map-list-alternative">
          <h3>Map features</h3>
          <ul>
            {snapshot.signals.slice(0, 4).map((signal) => <li key={signal.id}><button onClick={() => setSelectedSignalId(signal.id)}><MapPin aria-hidden /><span><strong>{signal.name}</strong><small>{signal.status.replaceAll("_", " ")} · {signal.confidence}%</small></span><ChevronRight aria-hidden /></button></li>)}
          </ul>
        </div>}
      </section>

      <aside className="inspector live-inspector" aria-label="Selected cluster details">
        <div className="inspector-title-row">
          <div><h2>{selected.name} Cluster <span>{selected.id}</span></h2><div className="inline-status"><StatusPill tone="danger">Severe</StatusPill><Confidence value={selected.confidence} /><span>{selected.updatedMinutesAgo} min ago</span></div></div>
          <button type="button" className="icon-quiet" aria-label="More cluster options">•••</button>
        </div>

        <section className="inspector-section">
          <h3>Why this changed</h3>
          <div className="reason-list">{confidenceReason.map(({ icon: Icon, label, value }) => <button key={label} type="button"><Icon aria-hidden /><span>{label}</span><small>{value}</small><ChevronRight aria-hidden /></button>)}</div>
        </section>

        <section className="inspector-section">
          <h3>Impact</h3>
          <div className="impact-strip">
            <Metric icon={Users} value={selected.peopleExposed.toLocaleString("en-IN")} label="People likely impacted" />
            <Metric icon={Route} value={selected.roadsAtRisk} label="Roads at risk" />
            <Metric icon={Building2} value={selected.sheltersReachable} label="Shelters reachable" />
          </div>
        </section>

        <section className="inspector-section inspector-grow">
          <div className="section-heading-inline"><h3>Evidence</h3><Button variant="link" onClick={() => onNavigate("signals")}>View all {selected.receivedReports} reports</Button></div>
          <ul className="evidence-summary-list">
            {selected.evidence.slice(0, 5).map((report) => <li key={report.id}><FileCheck2 aria-hidden /><span>{report.note}</span><small>{report.source}</small><time>{report.observedAt}</time></li>)}
          </ul>
        </section>

        <section className="recommended-action">
          <div><ShieldAlert aria-hidden /><span><strong>Recommended action</strong><small>{action.detail}</small></span></div>
          <div className="version-binding"><span>Evidence {action.evidenceVersion}</span><span>Model {action.modelVersion}</span></div>
          <p><strong>Two-person approval</strong><span>{reviewable ? `${role} · request v${action.approvalVersion}` : "Authoritative request unavailable"}</span></p>
          <div className="decision-buttons">
            <Button disabled={!reviewable} onClick={() => setDecision("APPROVE")}>Approve action</Button>
            <Button disabled={!reviewable} variant="outline" onClick={() => setDecision("MODIFY")}>Modify</Button>
            <Button disabled={!reviewable} variant="destructive-outline" onClick={() => setDecision("REJECT")}>Reject</Button>
          </div>
        </section>
      </aside>

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
    </div>
  );
}

function Metric({ icon: Icon, value, label }: { icon: typeof Users; value: string | number; label: string }) {
  return <div><Icon aria-hidden /><strong>{value}</strong><small>{label}</small></div>;
}
