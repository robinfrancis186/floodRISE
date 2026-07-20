import { FloodMap, type FloodMapSelection } from "@floodrise/map";
import { Badge, Button, Select } from "@floodrise/ui";
import {
  ArrowRight,
  Building2,
  Check,
  ChevronRight,
  ClipboardCheck,
  Download,
  FilePlus2,
  Hospital,
  MapPinned,
  MoreVertical,
  Route,
  ShieldCheck,
  Users,
  Waves,
  X,
} from "lucide-react";
import { useState } from "react";
import { Confidence, StatusPill } from "../components/status-pill";
import { useOperations } from "../state/operations-context";

export function ResilienceView() {
  const { snapshot, selectedPriorityId, setSelectedPriorityId } = useOperations();
  const selected = snapshot.priorities.find((priority) => priority.id === selectedPriorityId) ?? snapshot.priorities[0];
  const [compare, setCompare] = useState(false);
  const [taskCreated, setTaskCreated] = useState(false);
  const [exported, setExported] = useState(false);
  const handleMapSelection = (selection: FloodMapSelection) => {
    if (selection.kind !== "hotspot") return;
    const priority = snapshot.priorities.find((item) => item.rank === Number(selection.properties.rank));
    if (priority) setSelectedPriorityId(priority.id);
  };

  const exportBriefing = () => {
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

  return (
    <div className="workspace resilience-workspace">
      <section className="resilience-map" aria-label="Resilience priority map">
        <div className="audit-controls">
          <label>Event range<Select><option>2022–2026</option><option>2024–2026</option><option>2026 only</option></Select></label>
          <label>Evidence quality<Select><option>Verified + official</option><option>All evidence</option></Select></label>
          <fieldset><legend>Layers</legend><label><input type="checkbox" defaultChecked />Recurring flooding</label><label><input type="checkbox" defaultChecked />Drainage issues</label><label><input type="checkbox" defaultChecked />Road isolation</label><label><input type="checkbox" defaultChecked />Shelter gaps</label></fieldset>
        </div>
        <FloodMap variant="resilience" selectedFeatureId={`hotspot-${selected.rank}`} onFeatureSelect={handleMapSelection} className="shared-map" height="100%" ariaLabel="Kerala recurring flood, road isolation and shelter access priorities" />
      </section>

      <section className="resilience-content">
        <header className="resilience-toolbar">
          <div><h2>Kerala resilience priorities</h2><label>Ward<Select><option>All wards</option><option>Ward 110</option><option>Ward 121</option></Select></label><label>Asset type<Select><option>All</option><option>Drainage</option><option>Road</option><option>Shelter</option></Select></label><label>Confidence<Select><option>All</option><option>High</option></Select></label></div>
          <div><Button variant="outline" onClick={() => setCompare((value) => !value)}>{compare ? "Hide comparison" : "Compare scenario"}</Button><Button onClick={exportBriefing}><Download />{exported ? "Briefing exported" : "Export briefing"}</Button><Button variant="ghost" size="icon" aria-label="More audit options"><MoreVertical /></Button></div>
        </header>

        <div className="resilience-metrics">
          <Metric icon={Waves} value="18" label="Recurring hotspots" />
          <Metric icon={Route} value="11" label="Road bottlenecks" tone="danger" />
          <Metric icon={Building2} value="4" label="Shelter access gaps" tone="warning" />
          <Metric icon={Users} value="72%" label="Population within 30 min of an eligible shelter" tone="success" />
        </div>

        <div className="priority-table" role="table" aria-label="Ranked resilience priorities">
          <div className="priority-header" role="row"><span role="columnheader">Rank</span><span role="columnheader">Location / asset</span><span role="columnheader">Evidence</span><span role="columnheader">Impact</span><span role="columnheader">Confidence</span></div>
          {snapshot.priorities.map((priority) => <button role="row" key={priority.id} className="priority-row" data-selected={priority.id === selected.id || undefined} onClick={() => setSelectedPriorityId(priority.id)}>
            <span role="cell"><b>{priority.rank}</b></span><span role="cell">{priority.location}</span><span role="cell">{priority.evidence}</span><span role="cell">{priority.impact}</span><span role="cell"><Confidence value={priority.confidence} /></span>
          </button>)}
        </div>

        <section className="priority-detail">
          <header><h2>{selected.location} <StatusPill tone="success">Rank #{selected.rank}</StatusPill></h2><button className="icon-quiet" type="button" aria-label="Close details"><X /></button></header>
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

          <div className="human-workflow"><Button onClick={() => setTaskCreated(true)}><FilePlus2 />{taskCreated ? "Inspection task created" : "Create inspection task"}</Button><Button variant="outline"><ClipboardCheck />Add engineer note</Button><Button variant="outline"><ShieldCheck />Request authority review</Button></div>
          <footer className="audit-provenance"><span>Audit ID <strong>AUD-CHN-2026-0718-001</strong></span><span>Model version <strong>floodRISE v2.3.1</strong></span><span>Evidence version <strong>EV-2026-07-15</strong></span><span>Compiled by <strong>Resilience engineer</strong></span></footer>
        </section>
      </section>
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
