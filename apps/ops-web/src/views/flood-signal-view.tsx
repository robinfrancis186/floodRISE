import { FloodMap, type FloodMapSelection } from "@floodrise/map";
import {
  Badge,
  Button,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@floodrise/ui";
import {
  Check,
  CheckCircle2,
  CircleDot,
  Clock3,
  Filter,
  Globe2,
  MapPin,
  MessageSquareText,
  RadioTower,
  ShieldCheck,
  Smartphone,
  UserCheck,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";
import { DecisionDialog } from "../components/decision-dialog";
import { Confidence, StatusPill } from "../components/status-pill";
import type { SignalDecision } from "../lib/models";
import { useOperations } from "../state/operations-context";

export function FloodSignalView() {
  const { snapshot, selectedSignalId, setSelectedSignalId, decideSignal, horizon, setHorizon } = useOperations();
  const [status, setStatus] = useState("all");
  const [ward, setWard] = useState("all");
  const [freshness, setFreshness] = useState("3h");
  const [confidence, setConfidence] = useState("all");
  const [decision, setDecision] = useState<SignalDecision | null>(null);
  const selected = snapshot.signals.find((signal) => signal.id === selectedSignalId) ?? snapshot.signals[0];

  const filteredSignals = useMemo(() => snapshot.signals.filter((signal) => {
    const statusMatch = status === "all" || (status === "review" && signal.decision === "UNREVIEWED") || (status === "verified" && signal.decision === "VERIFIED") || (status === "field" && signal.decision === "FIELD_CHECK");
    const wardMatch = ward === "all" || signal.ward === ward;
    const freshnessLimit = freshness === "1h" ? 60 : freshness === "3h" ? 180 : 1440;
    const freshnessMatch = signal.updatedMinutesAgo <= freshnessLimit;
    const confidenceMatch = confidence === "all" || (confidence === "high" && signal.confidence >= 80) || (confidence === "medium" && signal.confidence >= 65 && signal.confidence < 80);
    return statusMatch && wardMatch && freshnessMatch && confidenceMatch;
  }), [snapshot.signals, status, ward, freshness, confidence]);

  const verificationRows = [
    ["Spatial match (within 250 m)", `${selected.independentReports} / ${selected.receivedReports}`],
    ["Time window (within 30 min)", "8 / 30 min"],
    ["Identity / device independence", `${selected.independentReports} unique`],
    ["Evidence consistency", selected.status === "DISPUTED" ? "Conflict" : "High"],
  ];
  const excludedReports = Math.max(0, selected.receivedReports - selected.independentReports);
  const mapFeatureId = selected.id === "VEL-042" ? "cluster-velachery" : selected.id === "SAI-018" ? "cluster-saidapet" : selected.id === "PAL-031" ? "cluster-pallikaranai" : null;
  const handleMapSelection = (selection: FloodMapSelection) => {
    if (selection.kind !== "cluster") return;
    const match = snapshot.signals.find((signal) => selection.name.includes(signal.id) || selection.name.toLowerCase().includes(signal.name.toLowerCase()));
    if (match) setSelectedSignalId(match.id);
  };

  return (
    <div className="workspace signal-workspace">
      <section className="cluster-queue" aria-label="Report cluster queue">
        <div className="queue-heading"><h2>Report clusters</h2><span>{filteredSignals.length} in view</span></div>
        <div className="filter-grid">
          <label>Status<Select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="review">Needs review</option><option value="verified">Verified</option><option value="field">Field check</option></Select></label>
          <label>Ward<Select value={ward} onChange={(event) => setWard(event.target.value)}><option value="all">All wards</option>{[...new Set(snapshot.signals.map((signal) => signal.ward))].map((item) => <option key={item}>{item}</option>)}</Select></label>
          <label>Freshness<Select value={freshness} onChange={(event) => setFreshness(event.target.value)}><option value="1h">Last hour</option><option value="3h">Last 3 hours</option><option value="day">Today</option></Select></label>
          <label>Confidence<Select value={confidence} onChange={(event) => setConfidence(event.target.value)}><option value="all">All</option><option value="high">High (80%+)</option><option value="medium">Medium</option></Select></label>
        </div>
        <div className="queue-columns"><span>Cluster</span><span>Reports</span><span>Last update</span></div>
        <div className="cluster-list">
          {filteredSignals.map((signal) => <button key={signal.id} className="cluster-row" data-selected={signal.id === selected.id || undefined} onClick={() => setSelectedSignalId(signal.id)}>
            <span className={`signal-dot signal-${signal.decision.toLowerCase()}`} aria-hidden />
            <span className="cluster-main"><strong>{signal.id} · {signal.name}</strong><small>{signal.ward} · {signal.area}</small><span><MessageSquareText aria-hidden />{signal.receivedReports}<Smartphone aria-hidden />{signal.authenticatedReports}<Globe2 aria-hidden />1<UserCheck aria-hidden />{signal.independentReports}</span></span>
            <span className="cluster-meta"><time>{signal.updatedMinutesAgo} min ago</time><Confidence value={signal.confidence} /><small>{signal.decision === "UNREVIEWED" ? "Pending approval" : signal.decision.replaceAll("_", " ")}</small></span>
          </button>)}
          {!filteredSignals.length && <div className="empty-state"><Filter /><strong>No clusters match</strong><span>Change a filter to see available evidence.</span></div>}
        </div>
        <div className="queue-footer">Showing {filteredSignals.length} of {snapshot.signals.length} clusters</div>
      </section>

      <section className="signal-map-pane" aria-label="Selected FloodSignal map">
        <div className="map-layer-key">
          <span><i className="key-flood" />Current flooding</span>
          <span><i className="key-predicted" />Predicted {horizon}</span>
          <span><i className="key-boundary" />Cluster boundary (250 m)</span>
          <span><i className="key-report" />Counted reports ({selected.independentReports})</span>
          <span><i className="key-excluded" />Excluded evidence</span>
        </div>
        <FloodMap variant="signals" horizon={horizon} onHorizonChange={setHorizon} selectedFeatureId={mapFeatureId} onFeatureSelect={handleMapSelection} showLegend={false} className="shared-map" height="100%" ariaLabel={`Evidence map for ${selected.name} cluster`} />
      </section>

      <aside className="signal-review" aria-label={`${selected.name} evidence review`}>
        <header className="review-header">
          <div><span className="signal-dot signal-unreviewed" aria-hidden /><h2>{selected.id} · {selected.name}</h2></div>
          <p>{selected.independentReports} independent of {selected.receivedReports} received <span>•</span> {selected.confidence}% confidence <span>•</span> <strong>Expires in {selected.expiresInMinutes} min</strong></p>
          {selected.decision === "VERIFIED" && <StatusPill tone="success">Community corroborated — not an official confirmation</StatusPill>}
        </header>

        <section className="verification-progress">
          <div className="section-heading-inline"><h3>Verification rule progress</h3><span>4 confirmations required</span></div>
          <div className="verification-grid">
            <div>{verificationRows.map(([label, value]) => <div key={label}><CheckCircle2 aria-hidden /><span>{label}</span><strong>{value}</strong></div>)}</div>
            <aside>
              <strong>Excluded from count ({excludedReports})</strong>
              {excludedReports ? <p><Badge variant="secondary">D1</Badge> Duplicate report<br /><small>Same evidence family</small></p> : <p><small>No collapsed evidence families</small></p>}
              <strong>Possible conflict ({selected.conflictReports})</strong>
              {selected.conflictReports ? <p><Badge variant="warning">C1</Badge> Shallower estimate<br /><small>0.15–0.25 m</small></p> : <p><small>No material contradiction</small></p>}
            </aside>
          </div>
        </section>

        <section className="evidence-table-section">
          <h3>Evidence ({selected.independentReports} of {selected.receivedReports})</h3>
          <Table>
            <TableHeader><TableRow><TableHead>ID</TableHead><TableHead>Reporter</TableHead><TableHead>Source</TableHead><TableHead>Depth</TableHead><TableHead>Road</TableHead><TableHead>Time</TableHead><TableHead>Dist.</TableHead></TableRow></TableHeader>
            <TableBody>{selected.evidence.map((report, index) => <TableRow key={report.id} data-excluded={!report.counted || undefined}>
              <TableCell><span className={report.counted ? "report-id" : "report-id excluded"}>{report.counted ? index + 1 : "D1"}</span></TableCell>
              <TableCell>{report.reporter}</TableCell>
              <TableCell>{report.source === "Mobile app" ? <Smartphone aria-label="Mobile app" /> : report.source === "Responder" ? <ShieldCheck aria-label="Responder" /> : <Globe2 aria-label="Web" />}</TableCell>
              <TableCell>{report.depth}</TableCell><TableCell>{report.roadStatus}</TableCell><TableCell>{report.observedAt}</TableCell><TableCell>{report.distanceM} m</TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </section>

        <section className="model-comparison">
          <span><strong>Model comparison</strong><small>Observed reports align with predicted depth 0.6–0.9 m.</small></span>
          <span>Model residual <strong>+0.1 m</strong></span>
        </section>

        <footer className="review-actions">
          <p><FileClockIcon />Decision and evidence hashes will be written to the audit trail.</p>
          <div><Button onClick={() => setDecision("VERIFIED")}><Check />Verify flooding</Button><Button variant="outline" onClick={() => setDecision("FIELD_CHECK")}><RadioTower />Request field check</Button><Button variant="destructive-outline" onClick={() => setDecision("REJECTED")}>Reject cluster</Button></div>
        </footer>
      </aside>

      <DecisionDialog
        open={decision !== null}
        title={decision === "VERIFIED" ? "Verify community corroboration" : decision === "FIELD_CHECK" ? "Request a field check" : "Reject this cluster"}
        description={decision === "VERIFIED" ? "This records community-corroborated flooding. It is not an official confirmation or an evacuation order." : "Evidence is retained and the decision is appended to the audit trail."}
        confirmLabel={decision === "VERIFIED" ? "Verify flooding" : decision === "FIELD_CHECK" ? "Request field check" : "Reject cluster"}
        destructive={decision === "REJECTED"}
        requireNote={decision !== "VERIFIED"}
        onClose={() => setDecision(null)}
        onConfirm={(note) => decision ? decideSignal(selected.id, decision, note, selected.apiId, selected.apiVersion) : false}
      />
    </div>
  );
}

function FileClockIcon() {
  return <Clock3 aria-hidden />;
}
