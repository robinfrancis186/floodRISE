import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@floodrise/ui";
import { AlertTriangle, Clock3, FileCheck2, MapPinned, Plus, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Confidence, StatusPill } from "../components/status-pill";
import type { ViewId } from "../lib/models";
import { ViewHeader } from "../components/view-header";
import { useOperations } from "../state/operations-context";

export function IncidentsView({ onNavigate }: { onNavigate: (view: ViewId) => void }) {
  const { snapshot, mode } = useOperations();
  const [selectedId, setSelectedId] = useState(snapshot.incidents[0]?.id ?? "");
  const [exported, setExported] = useState(false);
  const selected = snapshot.incidents.find((incident) => incident.id === selectedId)
    ?? snapshot.incidents[0]
    ?? null;
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);
  const exportIncidentBrief = () => {
    if (!selected) return;
    const dataLabel = mode === "demo" ? "DEMO DATA" : "AUTHORITY SESSION";
    const body = [
      `floodRISE incident brief — ${dataLabel}`,
      `Incident: ${selected.name}`,
      `Identifier: ${selected.id}`,
      `Status: ${selected.status}`,
      `Severity: ${selected.severity}`,
      `Started: ${selected.startedAt}`,
      `Latest model: ${selected.modelVersion}`,
      `Population in rapid impact estimate: ${formatCount(selected.peopleExposed)}`,
      "Model outputs are rapid impact estimates. This brief is not an official warning or evacuation instruction.",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selected.id.toLowerCase()}-incident-brief.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    setExported(true);
  };
  const activeIncidents = snapshot.incidents.filter((incident) => incident.status === "ACTIVE");
  const knownWards = activeIncidents
    .map((incident) => incident.wards)
    .filter((wards): wards is number => wards !== null);
  const knownExposure = activeIncidents
    .map((incident) => incident.peopleExposed)
    .filter((people): people is number => people !== null);
  return <div className="page-workspace">
    <ViewHeader title="Incident Management" description="Activate, monitor, and review version-bound flood operations." actions={<Button disabled title={mode === "demo" ? "Incident creation requires an authorized live incident service and is unavailable in this deterministic demo." : "Incident creation is not enabled for this authority session."} aria-label={mode === "demo" ? "Create incident unavailable in demo" : "Create incident unavailable"}><Plus />Create incident</Button>} />
    <div className="summary-band">
      <Summary icon={AlertTriangle} value={String(activeIncidents.length)} label="Active incidents" tone="danger" />
      <Summary icon={MapPinned} value={knownWards.length ? String(knownWards.reduce((total, wards) => total + wards, 0)) : "Unknown"} label="Wards in active area" />
      <Summary icon={Users} value={knownExposure.length ? knownExposure.reduce((total, people) => total + people, 0).toLocaleString("en-IN") : "Unknown"} label="People in rapid impact estimate" />
      <Summary icon={Clock3} value={mode === "demo" ? "4 min" : "Unavailable"} label="Latest model age" tone={mode === "demo" ? "success" : "default"} />
    </div>
    <div className="master-detail">
      <section className="table-panel"><div className="panel-heading"><h3>Operational incidents</h3><span>{snapshot.incidents.length} records</span></div>
        <Table scrollLabel="Operational incident table"><TableHeader><TableRow><TableHead>Incident</TableHead><TableHead>Status</TableHead><TableHead>Severity</TableHead><TableHead>Wards</TableHead><TableHead>Exposure</TableHead><TableHead>Last update</TableHead></TableRow></TableHeader>
          <TableBody>{snapshot.incidents.map((incident) => <TableRow key={incident.id} data-state={incident.id === selected?.id ? "selected" : undefined} onClick={() => setSelectedId(incident.id)} tabIndex={0} onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && setSelectedId(incident.id)}>
            <TableCell><strong>{incident.name}</strong><small className="cell-subtitle">{incident.id}</small></TableCell><TableCell><StatusPill tone={incident.status === "ACTIVE" ? "danger" : incident.status === "MONITORING" ? "warning" : "neutral"}>{incident.status}</StatusPill></TableCell><TableCell>{incident.severity}</TableCell><TableCell>{formatCount(incident.wards)}</TableCell><TableCell>{formatCount(incident.peopleExposed)}</TableCell><TableCell>{incident.lastUpdate}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
        {!snapshot.incidents.length && <div className="empty-state"><AlertTriangle /><strong>No operational incident returned</strong><span>The authority service returned no incident records. No demo incident is substituted.</span></div>}
      </section>
      <aside className="detail-panel">{selected ? <><div className="detail-panel-heading"><span><AlertTriangle /></span><div><h3>{selected.name}</h3><p>{selected.id}</p></div></div>
        <dl className="detail-list"><div><dt>Status</dt><dd><Badge variant={selected.status === "ACTIVE" ? "destructive" : "secondary"}>{selected.status}</Badge></dd></div><div><dt>Started</dt><dd>{selected.startedAt}</dd></div><div><dt>Latest model</dt><dd>{selected.modelVersion}</dd></div><div><dt>Population exposure</dt><dd>{formatCount(selected.peopleExposed)}</dd></div></dl>
        <div className="safety-note"><FileCheck2 /><span><strong>Operational boundary</strong><small>Model outputs are rapid impact estimates. Official instructions require authorized approval.</small></span></div>
        <div className="stack-actions"><Button onClick={() => onNavigate("live")}>Open command workspace</Button><Button variant="outline" onClick={exportIncidentBrief}>{exported ? "Incident brief exported" : "Export incident brief"}</Button></div>
        {exported && <p className="action-feedback" role="status">{mode === "demo" ? "Demo brief downloaded." : "Authority-session brief downloaded."} It is not an official public warning.</p>}
        </> : <div className="empty-state"><AlertTriangle /><strong>No incident selected</strong><span>Incident details and export are unavailable.</span></div>}
      </aside>
    </div>
  </div>;
}

function Summary({ icon: Icon, value, label, tone = "default" }: { icon: typeof AlertTriangle; value: string; label: string; tone?: string }) {
  return <div data-tone={tone}><Icon /><span><strong>{value}</strong><small>{label}</small></span></div>;
}

function formatCount(value: number | null): string {
  return value === null ? "Unknown" : value.toLocaleString("en-IN");
}
