import { FloodMap, type FloodMapSelection } from "@floodrise/map";
import { Button } from "@floodrise/ui";
import {
  AlertTriangle,
  Building2,
  CloudRain,
  FileCheck2,
  GitCompareArrows,
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
  const { snapshot, mode, horizon, setHorizon, selectedSignalId, setSelectedSignalId, decideAction, role } = useOperations();
  const selected = snapshot.signals.find((signal) => signal.id === selectedSignalId)
    ?? snapshot.signals[0]
    ?? null;
  const action = snapshot.actions.find((candidate) => candidate.type === "AREA_CAUTION")
    ?? snapshot.actions[0]
    ?? null;
  const reviewable = action?.status === "PENDING_APPROVAL"
    && Boolean(action.approvalId && action.approvalVersion);
  const [decision, setDecision] = useState<"APPROVE" | "MODIFY" | "REJECT" | null>(null);
  const confidenceReason = useMemo(() => selected
    ? mode === "demo"
      ? [
          { icon: CloudRain, label: "Rainfall increase", value: "118 mm (3h)" },
          { icon: GitCompareArrows, label: "Rapid impact estimate", value: "Higher runoff" },
          { icon: Users, label: `${selected.independentReports} independent ground reports`, value: "3–8 min ago" },
        ]
      : [
          { icon: Users, label: "Independent evidence families", value: String(selected.independentReports) },
          { icon: FileCheck2, label: "Authenticated or trusted reports", value: String(selected.authenticatedReports) },
          { icon: GitCompareArrows, label: "Material contradictions", value: String(selected.conflictReports) },
        ]
    : [], [mode, selected]);
  const mapFeatureId = selected?.id === "ALV-042" ? "cluster-aluva" : selected?.id === "ELO-018" ? "cluster-eloor" : selected?.id === "KDG-031" ? "cluster-kadungalloor" : null;
  const handleMapSelection = (selection: FloodMapSelection) => {
    if (selection.kind !== "cluster") return;
    const match = snapshot.signals.find((signal) => selection.name.includes(signal.id) || selection.name.toLowerCase().includes(signal.name.toLowerCase()));
    if (match) setSelectedSignalId(match.id);
  };

  return (
    <div className="workspace live-workspace">
      {selected ? <div className="change-alert" role="status">
        <AlertTriangle aria-hidden />
        <strong>{mode === "demo" ? "Flood extent increased near Aluva" : "FloodSignal evidence updated"}</strong>
        <span>•</span><span>{selected.independentReports} independent reports</span>
        {mode === "demo"
          ? <><span>•</span><span>2 routes affected</span></>
          : <><span>•</span><span>{snapshot.routes.length} current route alternatives</span></>}
        <Button size="sm" onClick={() => onNavigate("signals")}>Review evidence</Button>
      </div> : <div className="change-alert change-alert-neutral" role="status">
        <FileCheck2 aria-hidden />
        <strong>No current FloodSignal cluster</strong>
        <span>The authority service returned no current evidence cluster. No demo evidence is substituted.</span>
      </div>}

      <section className="map-pane live-map-pane" aria-label="Flood impact map">
        {mode === "demo" ? <FloodMap
          variant="operations"
          horizon={horizon}
          onHorizonChange={setHorizon}
          selectedFeatureId={mapFeatureId}
          onFeatureSelect={handleMapSelection}
          cooperativeGestures
          className="shared-map"
          height="100%"
          ariaLabel="Kerala current flooding, predicted flooding, routes and shelters"
        /> : <div className="empty-state authoritative-map-empty" role="status">
          <MapUnavailableIcon />
          <strong>Authoritative map layers unavailable</strong>
          <span>No verified live geometry was supplied in this incident snapshot. Use the source-timestamped lists; no replay overlay is shown.</span>
        </div>}
      </section>

      <aside className="inspector live-inspector" aria-label="Selected cluster details">
        {selected ? <>
        <div className="inspector-title-row">
          <div><h2>{selected.name} Cluster <span>{selected.id}</span></h2><div className="inline-status"><StatusPill tone={mode === "demo" ? "danger" : "neutral"}>{mode === "demo" ? "Severe" : selected.status.replaceAll("_", " ")}</StatusPill><Confidence value={selected.confidence} /><span>{selected.updatedMinutesAgo === null ? "Freshness unavailable" : `${selected.updatedMinutesAgo} min ago`}</span></div></div>
        </div>

        <section className="inspector-section">
          <h3>Why this changed</h3>
          <div className="reason-list">{confidenceReason.map(({ icon: Icon, label, value }) => <div className="reason-item" key={label}><Icon aria-hidden /><span>{label}</span><small>{value}</small></div>)}</div>
        </section>

        <section className="inspector-section">
          <h3>Impact</h3>
          <div className="impact-strip">
            <Metric icon={Users} value={formatMetric(selected.peopleExposed)} label="People likely impacted" />
            <Metric icon={Route} value={formatMetric(selected.roadsAtRisk)} label="Roads at risk" />
            <Metric icon={Building2} value={formatMetric(selected.sheltersReachable)} label="Shelters reachable" />
          </div>
        </section>

        <section className="inspector-section inspector-grow">
          <div className="section-heading-inline"><h3>Evidence</h3><Button variant="link" onClick={() => onNavigate("signals")}>View all {selected.receivedReports} reports</Button></div>
          <ul className="evidence-summary-list">
            {selected.evidence.slice(0, 5).map((report) => <li key={report.id}><FileCheck2 aria-hidden /><span>{report.note}</span><small>{report.source}</small><time>{report.observedAt}</time></li>)}
          </ul>
          {!selected.evidence.length && <div className="empty-state"><FileCheck2 /><strong>No report details supplied</strong><span>Aggregate counts remain visible, but no report evidence was included in this response.</span></div>}
        </section>

        {action ? <section className="recommended-action">
          <div><ShieldAlert aria-hidden /><span><strong>Recommended action</strong><small>{action.detail}</small></span></div>
          <div className="version-binding"><span>Evidence {action.evidenceVersion}</span><span>Model {action.modelVersion}</span></div>
          <p><strong>Two-person approval</strong><span>{reviewable ? `${role} · request v${action.approvalVersion}` : "Authoritative request unavailable"}</span></p>
          <div className="decision-buttons">
            <Button disabled={!reviewable} onClick={() => setDecision("APPROVE")}>Approve action</Button>
            <Button disabled={!reviewable} variant="outline" onClick={() => setDecision("MODIFY")}>Request changes</Button>
            <Button disabled={!reviewable} variant="destructive-outline" onClick={() => setDecision("REJECT")}>Reject</Button>
          </div>
        </section> : <section className="recommended-action">
          <div><ShieldAlert aria-hidden /><span><strong>No current action request</strong><small>The authority service returned no version-bound action for this incident.</small></span></div>
        </section>}
        </> : <div className="empty-state signal-empty-state">
          <FileCheck2 />
          <strong>No authoritative cluster selected</strong>
          <span>Current impact, evidence, and approval details are unavailable.</span>
        </div>}
      </aside>

      <DecisionDialog
        open={decision !== null && action !== null}
        title={decision === "APPROVE" ? "Approve operational action" : decision === "MODIFY" ? "Return action for changes" : "Reject operational action"}
        description={decision === "MODIFY" ? "This closes the current bound request without dispatch. The requester must submit a revised action for a new independent approval." : "This decision is bound to the displayed evidence and model versions. Official actions require authorized human approval."}
        confirmLabel={decision === "APPROVE" ? "Approve action" : decision === "MODIFY" ? "Return for changes" : "Reject action"}
        destructive={decision === "REJECT"}
        requireNote={decision !== "APPROVE"}
        onClose={() => setDecision(null)}
        onConfirm={(note) => decision && action ? decideAction(action.id, decision, note) : false}
      />
    </div>
  );
}

function Metric({ icon: Icon, value, label }: { icon: typeof Users; value: string | number; label: string }) {
  return <div><Icon aria-hidden /><strong>{value}</strong><small>{label}</small></div>;
}

function formatMetric(value: number | null): string {
  return value === null ? "Unknown" : value.toLocaleString("en-IN");
}

function MapUnavailableIcon() {
  return <Route aria-hidden />;
}
