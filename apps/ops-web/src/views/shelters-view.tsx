import { FloodMap, type FloodMapSelection } from "@floodrise/map";
import { Button, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@floodrise/ui";
import { AlertTriangle, Building2, CheckCircle2, Clock3, LoaderCircle, MapPin, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { StatusPill } from "../components/status-pill";
import { ViewHeader } from "../components/view-header";
import type { ShelterRecord } from "../lib/models";
import { useOperations } from "../state/operations-context";

export function SheltersView() {
  const { snapshot, mode, updateShelter, connected, role } = useOperations();
  const [selectedId, setSelectedId] = useState(snapshot.shelters[0]?.id ?? "");
  const selected = snapshot.shelters.find((shelter) => shelter.id === selectedId)
    ?? snapshot.shelters[0]
    ?? null;
  const [status, setStatus] = useState<ShelterRecord["status"]>(selected?.status ?? "UNKNOWN");
  const [occupancy, setOccupancy] = useState(selected?.occupancy === null || selected?.occupancy === undefined ? "" : String(selected.occupancy));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!selected) return;
    setStatus(selected.status);
    setOccupancy(selected.occupancy === null ? "" : String(selected.occupancy));
    setReason("");
    if (selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);
  const utilization = selected?.occupancy !== null
    && selected?.occupancy !== undefined
    && selected.capacity !== null
    && selected.capacity > 0
    ? Math.round((selected.occupancy / selected.capacity) * 100)
    : null;
  const canUpdate = Boolean(
    selected
    && connected
    && selected.apiId
    && selected.apiVersion
    && selected.capacity !== null
    && selected.occupancy !== null
    && selected.status !== "UNKNOWN"
    && status !== "UNKNOWN"
    && (role === "Shelter manager" || role === "Incident commander"),
  );
  const handleMapSelection = (selection: FloodMapSelection) => {
    if (selection.kind !== "shelter") return;
    const shelter = snapshot.shelters.find((item) => item.name.toLowerCase().includes(selection.name.split(" Shelter")[0].toLowerCase()));
    if (shelter) setSelectedId(shelter.id);
  };
  return <div className="page-workspace shelters-page">
    <ViewHeader title="Shelter Operations" description="Capacity and route access are source-timestamped; unknown conditions remain explicitly unknown." actions={<StatusPill tone="success">{snapshot.shelters.filter((shelter) => shelter.status === "OPEN").length} records open</StatusPill>} />
    <div className="shelter-layout">
      <section className="table-panel shelter-table"><div className="panel-heading"><h3>{mode === "demo" ? "Kerala shelters" : "Incident shelters"}</h3><span>{snapshot.shelters.length} in incident area</span></div>
        <Table scrollLabel="Shelter status table"><TableHeader><TableRow><TableHead>Shelter</TableHead><TableHead>Status</TableHead><TableHead>Occupancy</TableHead><TableHead>Access</TableHead><TableHead>Freshness</TableHead></TableRow></TableHeader>
          <TableBody>{snapshot.shelters.map((shelter) => <TableRow key={shelter.id} data-state={shelter.id === selected?.id ? "selected" : undefined} onClick={() => setSelectedId(shelter.id)} tabIndex={0} onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setSelectedId(shelter.id);
            }
          }}>
            <TableCell><strong>{shelter.name}</strong><small className="cell-subtitle">{shelter.ward} · {shelter.id}</small></TableCell><TableCell><StatusPill tone={shelter.status === "OPEN" ? "success" : shelter.status === "LIMITED" ? "warning" : shelter.status === "FULL" ? "danger" : "neutral"}>{shelter.status}</StatusPill></TableCell><TableCell>{formatCapacity(shelter.occupancy)} / {formatCapacity(shelter.capacity)}</TableCell><TableCell>{shelter.access}</TableCell><TableCell>{shelter.updatedMinutesAgo === null ? "Unavailable" : `${shelter.updatedMinutesAgo} min ago`}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
        {!snapshot.shelters.length && <div className="empty-state"><Building2 /><strong>No authoritative shelter records</strong><span>No demo shelter or capacity is substituted.</span></div>}
      </section>
      <section className="shelter-map">{mode === "demo" && selected
        ? <FloodMap variant="operations" selectedFeatureId={selected.name.includes("Aluva") ? "shelter-aluva" : undefined} onFeatureSelect={handleMapSelection} cooperativeGestures className="shared-map" height="100%" ariaLabel="Shelters, current flood extent, and route access" />
        : <div className="empty-state authoritative-map-empty" role="status"><MapPin /><strong>Authoritative shelter geometry unavailable</strong><span>No replay overlay is shown in an authority session.</span></div>}</section>
      <aside className="detail-panel shelter-detail">{selected ? <><div className="detail-panel-heading"><span><Building2 /></span><div><h3>{selected.name}</h3><p>{selected.ward} · {selected.updatedMinutesAgo === null ? "freshness unavailable" : `updated ${selected.updatedMinutesAgo} min ago`}</p></div></div>
        {utilization === null
          ? <p className="route-disclaimer"><AlertTriangle />Occupancy utilization is unknown because capacity or occupancy was not supplied.</p>
          : <div className="occupancy-gauge"><span style={{ width: `${utilization}%` }} /><p><strong>{utilization}%</strong> occupied</p></div>}
        <div className="shelter-facts"><span><Users /><strong>{selected.capacity === null || selected.occupancy === null ? "Unknown" : selected.capacity - selected.occupancy}</strong><small>spaces remaining</small></span><span><MapPin /><strong>{selected.access}</strong><small>route access</small></span><span><Clock3 /><strong>{selected.updatedMinutesAgo === null ? "Unknown" : `${selected.updatedMinutesAgo} min`}</strong><small>source age</small></span></div>
        {selected.access === "Unknown" && <p className="route-disclaimer"><AlertTriangle />Access is unknown. Do not infer that this route is open.</p>}
        <form className="shelter-update" onSubmit={async (event) => {
          event.preventDefault();
          if (!selected || status === "UNKNOWN") return;
          setSaving(true);
          await updateShelter(selected.id, status, Number(occupancy), reason.trim());
          setSaving(false);
        }}>
          <h4>Update shelter status</h4><label>Status<Select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="UNKNOWN" disabled>Unknown</option><option value="OPEN">Open</option><option value="LIMITED">Limited</option><option value="FULL">Full</option></Select></label><label>Current occupancy<Input type="number" min="0" max={selected.capacity ?? undefined} value={occupancy} onChange={(event) => setOccupancy(event.target.value)} /></label><label>Update reason<Input minLength={3} maxLength={500} required value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for the operational record" /></label>
          {(!connected || !selected.apiId || !selected.apiVersion || selected.capacity === null || selected.occupancy === null || selected.status === "UNKNOWN") && <p className="shelter-save-state"><AlertTriangle />Authoritative shelter data is incomplete or unavailable. Saving is disabled and displayed values will not be changed.</p>}
          {connected && !(role === "Shelter manager" || role === "Incident commander") && <p className="shelter-save-state"><AlertTriangle />Switch to shelter manager or incident commander to save this update.</p>}
          <Button type="submit" disabled={saving || !canUpdate || reason.trim().length < 3 || occupancy === ""}>{saving ? <LoaderCircle className="saving-spinner" /> : <CheckCircle2 />}{saving ? "Saving…" : "Save status"}</Button>
        </form>
        </> : <div className="empty-state"><Building2 /><strong>No shelter selected</strong><span>Capacity, access, and update controls are unavailable.</span></div>}
      </aside>
    </div>
  </div>;
}

function formatCapacity(value: number | null): string {
  return value === null ? "Unknown" : value.toLocaleString("en-IN");
}
