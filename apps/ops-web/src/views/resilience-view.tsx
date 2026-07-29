import {
  FloodMap,
  type FloodMapSelection,
  type ResilienceLayerVisibility,
} from "@floodrise/map";
import { Button, Select } from "@floodrise/ui";
import {
  ArrowRight,
  Building2,
  Check,
  ClipboardCheck,
  Download,
  FilePlus2,
  SlidersHorizontal,
  Route,
  ShieldCheck,
  Users,
  Waves,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { DecisionDialog } from "../components/decision-dialog";
import { Confidence, StatusPill } from "../components/status-pill";
import { useOperations } from "../state/operations-context";

export function ResilienceView() {
  const { snapshot, selectedPriorityId, setSelectedPriorityId } = useOperations();
  const [eventRange, setEventRange] = useState("all");
  const [evidenceQuality, setEvidenceQuality] = useState("all");
  const [ward, setWard] = useState("all");
  const [assetType, setAssetType] = useState("all");
  const [confidence, setConfidence] = useState("all");
  const [layers, setLayers] = useState<ResilienceLayerVisibility>({
    recurringFlooding: true,
    drainageIssues: true,
    roadIsolation: true,
    shelterGaps: true,
  });
  const [mapControlsOpen, setMapControlsOpen] = useState(false);
  const [compare, setCompare] = useState(false);
  const [detailOpen, setDetailOpen] = useState(true);
  const [inspectionDrafts, setInspectionDrafts] = useState<Set<string>>(() => new Set());
  const [engineerNotes, setEngineerNotes] = useState<Record<string, string>>({});
  const [engineerNoteOpen, setEngineerNoteOpen] = useState(false);
  const [exported, setExported] = useState(false);
  const wardOptions = useMemo(
    () => [...new Set(snapshot.priorities.map((priority) => priority.ward))],
    [snapshot.priorities],
  );
  const filteredPriorities = useMemo(() => {
    const firstYear = eventRange === "2024" ? 2024 : eventRange === "2026" ? 2026 : 2022;
    return snapshot.priorities.filter((priority) => (
      priority.eventYears.some((year) => year >= firstYear)
      && (evidenceQuality === "all" || priority.hasOfficialEvidence)
      && (ward === "all" || priority.ward === ward)
      && (assetType === "all" || priority.assetType === assetType)
      && (confidence === "all" || priority.confidence >= 80)
    ));
  }, [assetType, confidence, eventRange, evidenceQuality, snapshot.priorities, ward]);
  const selected = filteredPriorities.find((priority) => priority.id === selectedPriorityId) ?? filteredPriorities[0];
  const visibleFeatureIds = useMemo(
    () => layers.recurringFlooding ? filteredPriorities.map((priority) => `hotspot-${priority.rank}`) : [],
    [filteredPriorities, layers.recurringFlooding],
  );
  const handleMapSelection = (selection: FloodMapSelection) => {
    if (selection.kind !== "hotspot") return;
    const priority = filteredPriorities.find((item) => item.rank === Number(selection.properties.rank));
    if (priority) {
      setSelectedPriorityId(priority.id);
      setDetailOpen(true);
    }
  };

  const exportBriefing = () => {
    if (!selected) return;
    const body = [
      "floodRISE Resilience Audit — DEMO DATA",
      `Priority: ${selected.location}`,
      `Evidence: ${selected.evidence}`,
      `Impact: ${selected.impact}`,
      `Recommendation: ${selected.recommendation}`,
      "What-if results are modelled scenarios, not engineering designs.",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "floodrise-resilience-briefing-demo.txt";
    anchor.click();
    URL.revokeObjectURL(url);
    setExported(true);
  };
  const setLayer = (layer: keyof ResilienceLayerVisibility, shown: boolean) => {
    setLayers((current) => ({ ...current, [layer]: shown }));
  };
  const createInspectionDraft = () => {
    if (!selected) return;
    setInspectionDrafts((current) => new Set(current).add(selected.id));
  };

  return (
    <div className="workspace resilience-workspace">
      <section className="resilience-map" aria-label="Resilience priority map">
        <Button
          className="audit-controls-toggle"
          variant="outline"
          type="button"
          aria-controls="resilience-map-controls"
          aria-expanded={mapControlsOpen}
          onClick={() => setMapControlsOpen((open) => !open)}
        >
          <SlidersHorizontal aria-hidden />{mapControlsOpen ? "Hide map filters" : "Map filters"}
        </Button>
        <div className="audit-controls" id="resilience-map-controls" data-open={mapControlsOpen || undefined}>
          <label>Event range<Select value={eventRange} onChange={(event) => setEventRange(event.target.value)}><option value="all">2022–2026</option><option value="2024">2024–2026</option><option value="2026">2026 only</option></Select></label>
          <label>Evidence quality<Select value={evidenceQuality} onChange={(event) => setEvidenceQuality(event.target.value)}><option value="all">All verified evidence</option><option value="official">Official-backed only</option></Select></label>
          <fieldset><legend>Layers</legend>
            <label><input type="checkbox" checked={layers.recurringFlooding} onChange={(event) => setLayer("recurringFlooding", event.target.checked)} />Recurring flooding</label>
            <label><input type="checkbox" checked={layers.drainageIssues} onChange={(event) => setLayer("drainageIssues", event.target.checked)} />Drainage issues</label>
            <label><input type="checkbox" checked={layers.roadIsolation} onChange={(event) => setLayer("roadIsolation", event.target.checked)} />Road isolation</label>
            <label><input type="checkbox" checked={layers.shelterGaps} onChange={(event) => setLayer("shelterGaps", event.target.checked)} />Shelter gaps</label>
          </fieldset>
        </div>
        <FloodMap
          variant="resilience"
          selectedFeatureId={selected ? `hotspot-${selected.rank}` : null}
          visibleFeatureIds={visibleFeatureIds}
          resilienceLayers={layers}
          onFeatureSelect={handleMapSelection}
          showLegend={false}
          cooperativeGestures
          className="shared-map"
          height="100%"
          ariaLabel="Kerala recurring flood, road isolation and shelter access priorities"
        />
      </section>

      <section className="resilience-content">
        <header className="resilience-toolbar">
          <div><h2>Kerala resilience priorities</h2>
            <label>Ward<Select value={ward} onChange={(event) => setWard(event.target.value)}><option value="all">All wards</option>{wardOptions.map((item) => <option key={item} value={item}>{item}</option>)}</Select></label>
            <label>Asset type<Select value={assetType} onChange={(event) => setAssetType(event.target.value)}><option value="all">All</option><option value="Drainage">Drainage</option><option value="Road">Road</option><option value="Shelter">Shelter</option></Select></label>
            <label>Confidence<Select value={confidence} onChange={(event) => setConfidence(event.target.value)}><option value="all">All</option><option value="high">High (80%+)</option></Select></label>
          </div>
          <div><Button variant="outline" disabled={!selected} onClick={() => setCompare((value) => !value)}>{compare ? "Hide comparison" : "Compare scenario"}</Button><Button disabled={!selected} onClick={exportBriefing}><Download />{exported ? "Briefing exported" : "Export briefing"}</Button></div>
        </header>

        <div className="resilience-metrics">
          <Metric icon={Waves} value="18" label="Recurring hotspots" />
          <Metric icon={Route} value="11" label="Road bottlenecks" tone="danger" />
          <Metric icon={Building2} value="4" label="Shelter access gaps" tone="warning" />
          <Metric icon={Users} value="72%" label="Population within 30 min of an eligible shelter" tone="success" />
        </div>

        <p className="filter-result-note" role="status">Showing {filteredPriorities.length} of {snapshot.priorities.length} ranked priorities. Filters also update the mapped hotspot markers.</p>
        <div className="priority-table" role="table" aria-label="Ranked resilience priorities">
          <div className="priority-header" role="row"><span role="columnheader">Rank</span><span role="columnheader">Location / asset</span><span role="columnheader">Evidence</span><span role="columnheader">Impact</span><span role="columnheader">Confidence</span></div>
          {filteredPriorities.map((priority) => <button role="row" key={priority.id} className="priority-row" data-selected={priority.id === selected?.id || undefined} onClick={() => {
            setSelectedPriorityId(priority.id);
            setDetailOpen(true);
          }}>
            <span role="cell"><b>{priority.rank}</b></span><span role="cell">{priority.location}</span><span role="cell">{priority.evidence}</span><span role="cell">{priority.impact}</span><span role="cell"><Confidence value={priority.confidence} /></span>
          </button>)}
          {!filteredPriorities.length && <div className="empty-state"><ShieldCheck /><strong>No priorities match</strong><span>Broaden the ward, asset, confidence, date, or evidence filters.</span></div>}
        </div>

        {selected && detailOpen && <section className="priority-detail">
          <header><h2>{selected.location} <StatusPill tone="success">Rank #{selected.rank}</StatusPill></h2><button className="icon-quiet" type="button" aria-label="Close details" onClick={() => setDetailOpen(false)}><X /></button></header>
          <div className="priority-analysis">
            <section className="why-priority"><h3>Why this ranks first</h3><div className="why-metrics"><span><small>Recurrence</small><strong>{selected.recurrence}</strong><em>events (2022–2026)</em></span><span><small>Isolation</small><strong>+{selected.accessDelay} min</strong><em>average access delay</em></span><span><small>Population exposure</small><strong>{selected.population.toLocaleString("en-IN")}</strong><em>people</em></span><span><small>Confidence</small><strong>{selected.confidence}%</strong><em>High</em></span></div>
              <ClosureChart />
            </section>
            <aside className="priority-sources"><h3>Supporting sources</h3><p><Check />Field verified (6)</p><p><Check />Government reports (2)</p><p><Check />Satellite / remote sensing (1)</p><h3>Event dates</h3><p>22 Oct 2022<br />15 Nov 2023<br />27 Nov 2024<br />30 Oct 2025<br />08 Dec 2025<br />+4 more</p></aside>
            <aside className="recommendation-box"><h3>Recommendation (cautious)</h3><strong>{selected.recommendation}</strong><p>Follow-up options</p><span><ArrowRight />Assess desilting schedule</span><span><ArrowRight />Evaluate culvert capacity</span><span><ArrowRight />Consider water-level sensor</span></aside>
          </div>

          {compare && <div className="scenario-comparison">
            <header><h3>What-if comparison</h3><StatusPill tone="warning">Modelled, not an engineering design</StatusPill></header>
            <div><span /><strong>Population exposed</strong><strong>Average access delay</strong><strong>Recurring flooded area</strong></div>
            <div><span>Baseline (current)</span><b>{selected.population.toLocaleString("en-IN")} people</b><b>+{selected.accessDelay} min</b><b>2.8 km²</b></div>
            <div><span>Drain capacity +25%</span><b>{Math.round(selected.population * 0.71).toLocaleString("en-IN")} people</b><b>+{Math.max(3, selected.accessDelay - 9)} min</b><b>2.1 km²</b></div>
          </div>}

          {engineerNotes[selected.id] && <div className="engineer-note" role="status"><strong>Local engineer note</strong><span>{engineerNotes[selected.id]}</span></div>}
          <div className="human-workflow"><Button onClick={createInspectionDraft}><FilePlus2 />{inspectionDrafts.has(selected.id) ? "Inspection draft created" : "Create inspection draft"}</Button><Button variant="outline" onClick={() => setEngineerNoteOpen(true)}><ClipboardCheck />{engineerNotes[selected.id] ? "Edit engineer note" : "Add engineer note"}</Button><Button variant="outline" disabled title="Authority review requires a connected, authorized workflow and is unavailable in this deterministic demo."><ShieldCheck />Request authority review</Button></div>
          <p className="workflow-boundary">Inspection drafts and engineer notes stay in this local demo session. Authority review is unavailable until an authorized workflow is connected.</p>
          <footer className="audit-provenance"><span>Audit ID <strong>AUD-KER-2026-0718-001</strong></span><span>Model version <strong>floodRISE v2.3.1</strong></span><span>Evidence version <strong>EV-2026-07-15</strong></span><span>Compiled by <strong>Resilience engineer</strong></span></footer>
        </section>}
      </section>
      <DecisionDialog
        open={engineerNoteOpen && Boolean(selected)}
        title="Add engineer note"
        description={`Add context for ${selected?.location ?? "this priority"}. This remains a local demo draft and is not submitted to an authority or audit service.`}
        confirmLabel="Save local note"
        requireNote
        noteLabel="Engineer note"
        noteDescription="Stored in this browser session only; not an official review request."
        notePlaceholder="Record an observation or follow-up question…"
        onClose={() => setEngineerNoteOpen(false)}
        onConfirm={(note) => {
          if (!selected) return false;
          setEngineerNotes((current) => ({ ...current, [selected.id]: note.trim() }));
          return true;
        }}
      />
    </div>
  );
}

function Metric({ icon: Icon, value, label, tone = "default" }: { icon: typeof Waves; value: string; label: string; tone?: "default" | "danger" | "warning" | "success" }) {
  return <div data-tone={tone}><Icon aria-hidden /><span><strong>{value}</strong><small>{label}</small></span></div>;
}

function ClosureChart() {
  return <div className="closure-chart" aria-label="Closure hours across events: 24, 32, 48, 60, 36, and 42 hours">
    <h3>Closure hours across events</h3>
    <svg viewBox="0 0 600 112" role="img" aria-hidden="true" preserveAspectRatio="none"><path className="chart-grid" d="M24 88H586M24 54H586M24 20H586" /><polyline points="30,76 138,64 246,39 354,22 462,55 576,46" /><g>{[[30,76],[138,64],[246,39],[354,22],[462,55],[576,46]].map(([x,y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="4" />)}</g></svg>
    <div><span>Oct 2022</span><span>Nov 2023</span><span>Nov 2024</span><span>Oct 2025</span><span>Dec 2025</span><span>Jan 2026</span></div>
  </div>;
}
