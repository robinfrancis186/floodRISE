import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@floodrise/ui";
import { AlertTriangle, Clock3, FileCheck2, MapPinned, Users } from "lucide-react";
import { useState } from "react";
import { Confidence, StatusPill } from "../components/status-pill";
import { ViewHeader } from "../components/view-header";
import type { ViewId } from "../lib/models";
import { useOperations } from "../state/operations-context";

export function IncidentsView({ onNavigate }: { onNavigate: (view: ViewId) => void }) {
  const { snapshot } = useOperations();
  const [selectedId, setSelectedId] = useState(snapshot.incidents[0].id);
  const selected = snapshot.incidents.find((incident) => incident.id === selectedId) ?? snapshot.incidents[0];
  const exportBrief = () => {
    const text = ["floodRISE Incident Brief — DEMO DATA • NOT LIVE", `Incident: ${selected.name}`, `Status: ${selected.status}`, `Severity: ${selected.severity}`, `Wards: ${selected.wards}`, `Rapid impact estimate: ${selected.peopleExposed.toLocaleString("en-IN")} people`, `Model: ${selected.modelVersion}`, "Operational actions require authorized human approval."].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "floodrise-incident-brief-demo.txt";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return <div className="page-workspace">
    <ViewHeader title="Incident Management" description="Monitor and review version-bound flood operations." actions={<Badge variant="secondary">Single seeded demo incident</Badge>} />
    <div className="summary-band">
      <Summary icon={AlertTriangle} value={String(snapshot.incidents.filter((incident) => incident.status === "ACTIVE").length)} label="Active incidents" tone="danger" />
      <Summary icon={MapPinned} value={String(selected.wards)} label="Wards in selected area" />
      <Summary icon={Users} value={selected.peopleExposed.toLocaleString("en-IN")} label="People in rapid impact estimate" />
      <Summary icon={Clock3} value={selected.modelVersion} label="Current model version" tone="success" />
    </div>
    <div className="master-detail">
      <section className="table-panel"><div className="panel-heading"><h3>Operational incidents</h3><span>{snapshot.incidents.length} records</span></div>
        <Table><TableHeader><TableRow><TableHead>Incident</TableHead><TableHead>Status</TableHead><TableHead>Severity</TableHead><TableHead>Wards</TableHead><TableHead>Exposure</TableHead><TableHead>Last update</TableHead></TableRow></TableHeader>
          <TableBody>{snapshot.incidents.map((incident) => <TableRow key={incident.id} data-state={incident.id === selected.id ? "selected" : undefined} onClick={() => setSelectedId(incident.id)} tabIndex={0} onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && setSelectedId(incident.id)}>
            <TableCell><strong>{incident.name}</strong><small className="cell-subtitle">{incident.id}</small></TableCell><TableCell><StatusPill tone={incident.status === "ACTIVE" ? "danger" : incident.status === "MONITORING" ? "warning" : "neutral"}>{incident.status}</StatusPill></TableCell><TableCell>{incident.severity}</TableCell><TableCell>{incident.wards}</TableCell><TableCell>{incident.peopleExposed.toLocaleString("en-IN")}</TableCell><TableCell>{incident.lastUpdate}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </section>
      <aside className="detail-panel"><div className="detail-panel-heading"><span><AlertTriangle /></span><div><h3>{selected.name}</h3><p>{selected.id}</p></div></div>
        <dl className="detail-list"><div><dt>Status</dt><dd><Badge variant={selected.status === "ACTIVE" ? "destructive" : "secondary"}>{selected.status}</Badge></dd></div><div><dt>Started</dt><dd>{selected.startedAt}</dd></div><div><dt>Latest model</dt><dd>{selected.modelVersion}</dd></div><div><dt>Population exposure</dt><dd>{selected.peopleExposed.toLocaleString("en-IN")}</dd></div></dl>
        <div className="safety-note"><FileCheck2 /><span><strong>Operational boundary</strong><small>Model outputs are rapid impact estimates. Official instructions require authorized approval.</small></span></div>
        <div className="stack-actions"><Button onClick={() => onNavigate("live")}>Open live operations</Button><Button variant="outline" onClick={exportBrief}>Export incident brief</Button></div>
      </aside>
    </div>
  </div>;
}

function Summary({ icon: Icon, value, label, tone = "default" }: { icon: typeof AlertTriangle; value: string; label: string; tone?: string }) {
  return <div data-tone={tone}><Icon /><span><strong>{value}</strong><small>{label}</small></span></div>;
}
