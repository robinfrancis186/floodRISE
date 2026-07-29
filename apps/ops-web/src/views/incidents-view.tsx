import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@floodrise/ui";
import { AlertTriangle, Clock3, FileCheck2, MapPinned, Plus, Users } from "lucide-react";
import { useState } from "react";
import { Confidence, StatusPill } from "../components/status-pill";
import type { ViewId } from "../lib/models";
import { ViewHeader } from "../components/view-header";
import { useOperations } from "../state/operations-context";

export function IncidentsView({ onNavigate }: { onNavigate: (view: ViewId) => void }) {
  const { snapshot } = useOperations();
  const [selectedId, setSelectedId] = useState(snapshot.incidents[0].id);
  const [exported, setExported] = useState(false);
  const selected = snapshot.incidents.find((incident) => incident.id === selectedId) ?? snapshot.incidents[0];
  const exportIncidentBrief = () => {
    const body = [
      "floodRISE incident brief — DEMO DATA",
      `Incident: ${selected.name}`,
      `Identifier: ${selected.id}`,
      `Status: ${selected.status}`,
      `Severity: ${selected.severity}`,
      `Started: ${selected.startedAt}`,
      `Latest model: ${selected.modelVersion}`,
      `Population in rapid impact estimate: ${selected.peopleExposed.toLocaleString("en-IN")}`,
      "Model outputs are rapid impact estimates. This brief is not an official warning or evacuation instruction.",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selected.id.toLowerCase()}-brief-demo.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    setExported(true);
  };
  return <div className="page-workspace">
    <ViewHeader title="Incident Management" description="Activate, monitor, and review version-bound flood operations." actions={<Button disabled title="Incident creation requires an authorized live incident service and is unavailable in this deterministic demo." aria-label="Create incident unavailable in demo"><Plus />Create incident</Button>} />
    <div className="summary-band">
      <Summary icon={AlertTriangle} value="1" label="Active incident" tone="danger" />
      <Summary icon={MapPinned} value="18" label="Wards in active area" />
      <Summary icon={Users} value="84,260" label="People in rapid impact estimate" />
      <Summary icon={Clock3} value="4 min" label="Latest model age" tone="success" />
    </div>
    <div className="master-detail">
      <section className="table-panel"><div className="panel-heading"><h3>Operational incidents</h3><span>{snapshot.incidents.length} records</span></div>
        <Table scrollLabel="Operational incident table"><TableHeader><TableRow><TableHead>Incident</TableHead><TableHead>Status</TableHead><TableHead>Severity</TableHead><TableHead>Wards</TableHead><TableHead>Exposure</TableHead><TableHead>Last update</TableHead></TableRow></TableHeader>
          <TableBody>{snapshot.incidents.map((incident) => <TableRow key={incident.id} data-state={incident.id === selected.id ? "selected" : undefined} onClick={() => setSelectedId(incident.id)} tabIndex={0} onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && setSelectedId(incident.id)}>
            <TableCell><strong>{incident.name}</strong><small className="cell-subtitle">{incident.id}</small></TableCell><TableCell><StatusPill tone={incident.status === "ACTIVE" ? "danger" : incident.status === "MONITORING" ? "warning" : "neutral"}>{incident.status}</StatusPill></TableCell><TableCell>{incident.severity}</TableCell><TableCell>{incident.wards}</TableCell><TableCell>{incident.peopleExposed.toLocaleString("en-IN")}</TableCell><TableCell>{incident.lastUpdate}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </section>
      <aside className="detail-panel"><div className="detail-panel-heading"><span><AlertTriangle /></span><div><h3>{selected.name}</h3><p>{selected.id}</p></div></div>
        <dl className="detail-list"><div><dt>Status</dt><dd><Badge variant={selected.status === "ACTIVE" ? "destructive" : "secondary"}>{selected.status}</Badge></dd></div><div><dt>Started</dt><dd>{selected.startedAt}</dd></div><div><dt>Latest model</dt><dd>{selected.modelVersion}</dd></div><div><dt>Population exposure</dt><dd>{selected.peopleExposed.toLocaleString("en-IN")}</dd></div></dl>
        <div className="safety-note"><FileCheck2 /><span><strong>Operational boundary</strong><small>Model outputs are rapid impact estimates. Official instructions require authorized approval.</small></span></div>
        <div className="stack-actions"><Button onClick={() => onNavigate("live")}>Open command workspace</Button><Button variant="outline" onClick={exportIncidentBrief}>{exported ? "Incident brief exported" : "Export incident brief"}</Button></div>
        {exported && <p className="action-feedback" role="status">Demo brief downloaded. It is not an official public warning.</p>}
      </aside>
    </div>
  </div>;
}

function Summary({ icon: Icon, value, label, tone = "default" }: { icon: typeof AlertTriangle; value: string; label: string; tone?: string }) {
  return <div data-tone={tone}><Icon /><span><strong>{value}</strong><small>{label}</small></span></div>;
}
