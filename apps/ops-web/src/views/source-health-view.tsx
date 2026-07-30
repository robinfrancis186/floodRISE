import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@floodrise/ui";
import { CheckCircle2, Clock3, DatabaseZap, RefreshCcw, Satellite, ShieldAlert, Waves } from "lucide-react";
import { StatusPill } from "../components/status-pill";
import { ViewHeader } from "../components/view-header";
import { useOperations } from "../state/operations-context";

export function SourceHealthView() {
  const { snapshot, mode, connected, advanceDemo, refreshOperations, refreshing } = useOperations();
  const scenario = new Date(snapshot.scenarioTime).getTime();
  return <div className="page-workspace sources-page">
    <ViewHeader title="Source Health" description={`Every operational layer exposes its provider, observation time, cadence, confidence, and ${mode === "demo" ? "demo" : "authority"} status.`} actions={<Button variant="outline" onClick={mode === "demo" ? advanceDemo : refreshOperations} disabled={mode === "live" && refreshing}><RefreshCcw />{mode === "live" && refreshing ? "Refreshing checks" : "Refresh source checks"}</Button>} />
    <div className="source-overview">
      <div><DatabaseZap /><span><strong>{connected ? "Backend connected" : mode === "demo" ? "Deterministic local fallback" : "Authority backend unavailable"}</strong><small>{connected ? "Authenticated API responses" : mode === "demo" ? "No external provider dependency" : "No live source claim is available"}</small></span></div>
      <div><CheckCircle2 /><span><strong>{snapshot.sources.filter((source) => source.status === "HEALTHY").length} healthy</strong><small>Within declared cadence</small></span></div>
      <div><Clock3 /><span><strong>{snapshot.sources.filter((source) => source.status === "STALE").length} stale</strong><small>Last-known data remains visible</small></span></div>
      <div><ShieldAlert /><span><strong>{snapshot.sources.filter((source) => source.status === "UNKNOWN").length} unknown</strong><small>Never interpreted as normal</small></span></div>
    </div>
    <section className="table-panel"><div className="panel-heading"><h3>Operational data sources</h3><span>{mode === "demo" ? "Scenario clock" : "Data time"} {formatSourceTime(snapshot.scenarioTime)}</span></div>
      <Table scrollLabel="Operational source health table"><TableHeader><TableRow><TableHead>Provider</TableHead><TableHead>Status</TableHead><TableHead>Observed at</TableHead><TableHead>Source age</TableHead><TableHead>Cadence</TableHead><TableHead>Mode</TableHead></TableRow></TableHeader>
        <TableBody>{snapshot.sources.map((source) => {
          const observedTimestamp = new Date(source.observed_at).getTime();
          const age = Number.isFinite(scenario) && Number.isFinite(observedTimestamp)
            ? Math.max(0, Math.round((scenario - observedTimestamp) / 60_000))
            : null;
          const sourceMode = source.source_mode
            ?? (source.quality_flags?.includes("PACKAGED_BASELINE")
              ? "PACKAGED_BASELINE"
              : source.is_simulated
                ? "DEMO_FIXTURE"
                : "REFERENCE_DATA");
          const isEventTime = !source.quality_flags?.includes("NOT_EVENT_TIME")
            && sourceMode !== "PACKAGED_BASELINE"
            && sourceMode !== "REFERENCE_DATA";
          const sourceAge = isEventTime ? age === null ? "Unavailable" : `${age} min` : "Not event-time";
          return <TableRow key={source.id}><TableCell><strong>{source.provider}</strong><small className="cell-subtitle">{source.id}</small></TableCell><TableCell><StatusPill tone={source.status === "HEALTHY" ? "success" : source.status === "STALE" ? "warning" : "neutral"}>{source.status}</StatusPill></TableCell><TableCell>{formatSourceTime(source.observed_at, true)}</TableCell><TableCell>{sourceAge}</TableCell><TableCell>{source.cadence}</TableCell><TableCell><StatusPill tone={sourceMode === "LIVE" ? "success" : "warning"}>{sourceMode.replaceAll("_", " ")}</StatusPill></TableCell></TableRow>;
        })}</TableBody>
      </Table>
      {!snapshot.sources.length && <div className="empty-state"><DatabaseZap /><strong>No authoritative source records</strong><span>The connected bootstrap returned no valid source-health records. No demo source is substituted.</span></div>}
    </section>
    <p className="source-policy"><Satellite /><span><strong>Provider policy</strong>Permission-gated sources are never scraped or redistributed. Missing and delayed data remain labeled unknown or stale.</span></p>
  </div>;
}

function formatSourceTime(value: string, includeDate = false): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) return "Unavailable";
  return includeDate
    ? timestamp.toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
      })
    : `${timestamp.toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
      })} IST`;
}
