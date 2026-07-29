import { Button, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@floodrise/ui";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, FileClock, Fingerprint, LoaderCircle, Search, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { StatusPill } from "../components/status-pill";
import { ViewHeader } from "../components/view-header";
import { apiIdentityForRole, fetchAuditStatus } from "../lib/api";
import { useOperations } from "../state/operations-context";

export function AuditView() {
  const { snapshot, role } = useOperations();
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState("all");
  const authorized = role === "Auditor" || role === "Incident commander";
  const auditQuery = useQuery({
    queryKey: ["authoritative-audit", role],
    queryFn: () => fetchAuditStatus(apiIdentityForRole(role)),
    enabled: authorized,
    retry: false,
  });
  const authoritative = auditQuery.isSuccess;
  const visibleRecords = authoritative ? auditQuery.data.records : snapshot.audit;
  const rows = useMemo(() => visibleRecords.filter((record) => {
    const matchesText = `${record.actor} ${record.event} ${record.resource}`.toLowerCase().includes(query.toLowerCase());
    return matchesText && (outcome === "all" || record.outcome === outcome);
  }), [visibleRecords, query, outcome]);
  const exportAudit = () => {
    const exportRows = authoritative ? rows : rows.map((record) => ({ ...record, hash: "DEMO_FIXTURE_NOT_VERIFIED" }));
    const url = URL.createObjectURL(new Blob([JSON.stringify(exportRows, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = authoritative ? "floodrise-audit-visible.json" : "floodrise-audit-demo-fixture.json"; anchor.click(); URL.revokeObjectURL(url);
  };
  const auditState = !authorized ? "restricted" : auditQuery.isPending ? "loading" : auditQuery.isError ? "unavailable" : auditQuery.data.chainValid ? "valid" : "invalid";
  const authoritativeRecordCount = auditQuery.data?.records.length ?? 0;
  return <div className="page-workspace audit-page">
    <ViewHeader title="Audit Log" description="Append-only operational evidence, decisions, versions, and delivery outcomes." actions={<Button onClick={exportAudit}><Download />Export visible rows</Button>} />
    <div className="audit-verification" data-state={auditState}>
      {auditState === "loading" ? <LoaderCircle className="saving-spinner" /> : auditState === "invalid" || auditState === "unavailable" || auditState === "restricted" ? <AlertTriangle /> : <Fingerprint />}
      <span>
        <strong>{auditState === "valid" ? "Server verified audit chain" : auditState === "invalid" ? "Audit chain integrity warning" : auditState === "loading" ? "Checking audit integrity" : auditState === "restricted" ? "Audit verification restricted" : "Audit verification unavailable"}</strong>
        <small>{auditState === "valid" ? `${authoritativeRecordCount} authoritative events returned · corrections supersede earlier records` : auditState === "invalid" ? "The server reported that the audit chain is invalid. Do not rely on these records until investigated." : auditState === "loading" ? "Waiting for an authoritative response from the audit service." : auditState === "restricted" ? "Switch to auditor or incident commander to request authoritative audit status. Fixture rows are shown below." : "No integrity claim is shown. Deterministic fixture rows are displayed below."}</small>
      </span>
      <StatusPill tone={auditState === "valid" ? "success" : auditState === "invalid" ? "danger" : auditState === "loading" ? "info" : "warning"}>{auditState === "valid" ? <><CheckCircle2 />Integrity valid</> : auditState === "invalid" ? "Integrity invalid" : auditState === "loading" ? "Verifying" : "Not verified"}</StatusPill>
    </div>
    <div className="table-toolbar"><label className="table-search"><Search /><span className="sr-only">Search audit events</span><Input placeholder="Search actor, event, resource…" value={query} onChange={(event) => setQuery(event.target.value)} /></label><label>Outcome<Select value={outcome} onChange={(event) => setOutcome(event.target.value)}><option value="all">All outcomes</option><option value="RECORDED">Recorded</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option></Select></label></div>
    <section className="table-panel audit-table"><Table scrollLabel="Audit event table"><TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Actor / role</TableHead><TableHead>Event</TableHead><TableHead>Resource</TableHead><TableHead>Outcome</TableHead><TableHead>Hash</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((record) => <TableRow key={record.id}><TableCell>{record.occurredAt}</TableCell><TableCell><strong>{record.actor}</strong><small className="cell-subtitle">{record.role}</small></TableCell><TableCell>{record.event.replaceAll("_", " ")}</TableCell><TableCell>{record.resource}</TableCell><TableCell><StatusPill tone={record.outcome === "APPROVED" ? "success" : record.outcome === "REJECTED" ? "danger" : "info"}>{record.outcome}</StatusPill></TableCell><TableCell><code>{authoritative ? record.hash : "Fixture only"}</code></TableCell></TableRow>)}</TableBody>
    </Table>{!rows.length && <div className="empty-state"><FileClock /><strong>No audit events match</strong><span>Change the search or outcome filter.</span></div>}</section>
    <p className="source-policy"><ShieldCheck /><span><strong>Accountability boundary</strong>Every FloodSignal decision, simulation update, approval, and alert dispatch is version-bound and retained according to policy.</span></p>
  </div>;
}
