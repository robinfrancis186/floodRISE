import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@floodrise/ui";
import { CheckCircle2, Clock3, DatabaseZap, RefreshCcw, Satellite, ShieldAlert, Waves } from "lucide-react";
import { StatusPill } from "../components/status-pill";
import { ViewHeader } from "../components/view-header";
import { useOperations } from "../state/operations-context";

export function SourceHealthView() {
  const { snapshot, connected, advanceDemo } = useOperations();
  const scenario = new Date(snapshot.scenarioTime).getTime();
  return <div className="page-workspace sources-page">
    <ViewHeader title="Source Health" description="Every operational layer exposes its provider, observation time, cadence, confidence, and demo status." actions={<Button variant="outline" onClick={advanceDemo}><RefreshCcw />Refresh source checks</Button>} />
    <div className="source-overview">
      <div><DatabaseZap /><span><strong>{connected ? "Backend connected" : "Deterministic local fallback"}</strong><small>{connected ? "Authenticated API responses" : "No external provider dependency"}</small></span></div>
      <div><CheckCircle2 /><span><strong>{snapshot.sources.filter((source) => source.status === "HEALTHY").length} healthy</strong><small>Within declared cadence</small></span></div>
      <div><Clock3 /><span><strong>{snapshot.sources.filter((source) => source.status === "STALE").length} stale</strong><small>Last-known data remains visible</small></span></div>
      <div><ShieldAlert /><span><strong>{snapshot.sources.filter((source) => source.status === "UNKNOWN").length} unknown</strong><small>Never interpreted as normal</small></span></div>
    </div>
    <section className="table-panel"><div className="panel-heading"><h3>Operational data sources</h3><span>Scenario clock {new Date(snapshot.scenarioTime).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })} IST</span></div>
      <Table><TableHeader><TableRow><TableHead>Provider</TableHead><TableHead>Status</TableHead><TableHead>Observed at</TableHead><TableHead>Source age</TableHead><TableHead>Cadence</TableHead><TableHead>Mode</TableHead></TableRow></TableHeader>
        <TableBody>{snapshot.sources.map((source) => {
          const age = Math.max(0, Math.round((scenario - new Date(source.observed_at).getTime()) / 60_000));
          const sourceMode = source.source_mode
            ?? (source.quality_flags?.includes("PACKAGED_BASELINE")
              ? "PACKAGED_BASELINE"
              : source.is_simulated
                ? "DEMO_FIXTURE"
                : "REFERENCE_DATA");
          const isEventTime = !source.quality_flags?.includes("NOT_EVENT_TIME")
            && sourceMode !== "PACKAGED_BASELINE"
            && sourceMode !== "REFERENCE_DATA";
          const sourceAge = isEventTime ? `${age} min` : "Not event-time";
          return <TableRow key={source.id}><TableCell><strong>{source.provider}</strong><small className="cell-subtitle">{source.id}</small></TableCell><TableCell><StatusPill tone={source.status === "HEALTHY" ? "success" : source.status === "STALE" ? "warning" : "neutral"}>{source.status}</StatusPill></TableCell><TableCell>{new Date(source.observed_at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })}</TableCell><TableCell>{sourceAge}</TableCell><TableCell>{source.cadence}</TableCell><TableCell><StatusPill tone={sourceMode === "LIVE" ? "success" : "warning"}>{sourceMode.replaceAll("_", " ")}</StatusPill></TableCell></TableRow>;
        })}</TableBody>
      </Table>
      {!snapshot.sources.length && <div className="empty-state"><DatabaseZap /><strong>No authoritative source records</strong><span>The connected bootstrap returned no valid source-health records. No demo source is substituted.</span></div>}
    </section>
    <p className="source-policy"><Satellite /><span><strong>Provider policy</strong>Permission-gated sources are never scraped or redistributed. Missing and delayed data remain labeled unknown or stale.</span></p>
  </div>;
}
