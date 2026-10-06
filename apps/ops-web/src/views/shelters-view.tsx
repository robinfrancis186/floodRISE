import { FloodMap, type FloodMapSelection } from "@floodrise/map";
import { Button, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@floodrise/ui";
import { AlertTriangle, Building2, CheckCircle2, Clock3, LoaderCircle, MapPin, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { StatusPill } from "../components/status-pill";
import { ViewHeader } from "../components/view-header";
import { useOperations } from "../state/operations-context";

export function SheltersView() {
  const { snapshot, updateShelter, connected, role, selectedShelterId: selectedId, setSelectedShelterId: setSelectedId } = useOperations();
  const selected = snapshot.shelters.find((shelter) => shelter.id === selectedId) ?? snapshot.shelters[0];
  const [status, setStatus] = useState(selected.status);
  const [occupancy, setOccupancy] = useState(String(selected.occupancy));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setStatus(selected.status); setOccupancy(String(selected.occupancy)); setReason(""); }, [selected]);
  const utilization = Math.round((selected.occupancy / selected.capacity) * 100);
  const handleMapSelection = (selection: FloodMapSelection) => {
    if (selection.kind !== "shelter") return;
    const shelter = snapshot.shelters.find((item) => item.name.toLowerCase().includes(selection.name.split(" Shelter")[0].toLowerCase()));
    if (shelter) setSelectedId(shelter.id);
  };
  return <div className="page-workspace shelters-page">
    <ViewHeader title="Shelter Operations" description="Capacity and route access are source-timestamped; unknown conditions remain explicitly unknown." actions={<StatusPill tone="success">{snapshot.shelters.filter((shelter) => shelter.status === "OPEN").length} confirmed open</StatusPill>} />
    <div className="shelter-layout">
      <section className="table-panel shelter-table"><div className="panel-heading"><h3>Chennai shelters</h3><span>{snapshot.shelters.length} in incident area</span></div>
        <Table><TableHeader><TableRow><TableHead>Shelter</TableHead><TableHead>Status</TableHead><TableHead>Occupancy</TableHead><TableHead>Access</TableHead><TableHead>Freshness</TableHead></TableRow></TableHeader>
          <TableBody>{snapshot.shelters.map((shelter) => <TableRow key={shelter.id} data-state={shelter.id === selected.id ? "selected" : undefined} onClick={() => setSelectedId(shelter.id)}>
            <TableCell><strong>{shelter.name}</strong><small className="cell-subtitle">{shelter.ward} · {shelter.id}</small></TableCell><TableCell><StatusPill tone={shelter.status === "OPEN" ? "success" : shelter.status === "LIMITED" ? "warning" : "danger"}>{shelter.status}</StatusPill></TableCell><TableCell>{shelter.occupancy} / {shelter.capacity}</TableCell><TableCell>{shelter.access}</TableCell><TableCell>{shelter.updatedMinutesAgo} min ago</TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </section>
      <section className="shelter-map"><FloodMap variant="operations" selectedFeatureId={selected.name.includes("Velachery") ? "shelter-velachery" : undefined} onFeatureSelect={handleMapSelection} className="shared-map" height="100%" ariaLabel="Shelters, current flood extent, and route access" /></section>
      <aside className="detail-panel shelter-detail"><div className="detail-panel-heading"><span><Building2 /></span><div><h3>{selected.name}</h3><p>{selected.ward} · updated {selected.updatedMinutesAgo} min ago</p></div></div>
        <div className="occupancy-gauge"><span style={{ width: `${utilization}%` }} /><p><strong>{utilization}%</strong> occupied</p></div>
        <div className="shelter-facts"><span><Users /><strong>{selected.capacity - selected.occupancy}</strong><small>spaces remaining</small></span><span><MapPin /><strong>{selected.access}</strong><small>route access</small></span><span><Clock3 /><strong>{selected.updatedMinutesAgo} min</strong><small>source age</small></span></div>
        {selected.access === "Unknown" && <p className="route-disclaimer"><AlertTriangle />Access is unknown. Do not infer that this route is open.</p>}
        <form className="shelter-update" onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          await updateShelter(selected.id, status, Number(occupancy), reason.trim());
          setSaving(false);
        }}>
          <h4>Update shelter status</h4><label>Status<Select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="OPEN">Open</option><option value="LIMITED">Limited</option><option value="FULL">Full</option></Select></label><label>Current occupancy<Input type="number" min="0" max={selected.capacity} value={occupancy} onChange={(event) => setOccupancy(event.target.value)} /></label><label>Update reason<Input minLength={3} maxLength={500} required value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for the operational record" /></label>
          {(!connected || !selected.apiId || !selected.apiVersion) && <p className="shelter-save-state"><AlertTriangle />Authoritative shelter data is unavailable. Saving is disabled and displayed values will not be changed.</p>}
          {connected && !(role === "Shelter manager" || role === "Incident commander") && <p className="shelter-save-state"><AlertTriangle />Switch to shelter manager or incident commander to save this update.</p>}
          <Button type="submit" disabled={saving || !connected || !selected.apiId || !selected.apiVersion || reason.trim().length < 3 || !(role === "Shelter manager" || role === "Incident commander")}>{saving ? <LoaderCircle className="saving-spinner" /> : <CheckCircle2 />}{saving ? "Saving…" : "Save status"}</Button>
        </form>
      </aside>
    </div>
  </div>;
}
