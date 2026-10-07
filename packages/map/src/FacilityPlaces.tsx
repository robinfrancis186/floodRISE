import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { defaultFacilityKinds, facilityBaseline, facilityDistance, facilitySourceUrl, facilityKinds, findMapFacilities, type Facility, type FacilityKind, type FacilityBaseline } from "./facilities";
import type { MapPosition } from "./types";

export function Facilities({ map, onRegionChange, allowRegionSwitch }: { allowRegionSwitch: boolean; map: MapLibreMap | null; onRegionChange: (region: "chennai" | "kerala") => void }) {
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [kinds, setKinds] = useState<FacilityKind[]>(defaultFacilityKinds);
  const [region, setRegion] = useState<"chennai" | "kerala">("chennai");
  const [baseline, setBaseline] = useState(facilityBaseline);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(0);
  const baselineRef = useRef(baseline);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Facility | null>(null);
  const [origin, setOrigin] = useState<MapPosition>([80.225, 12.982]);
  const filtered = useMemo(() => findMapFacilities(kinds, query, undefined, baseline), [kinds, query, baseline]);
  const matches = useMemo(() => findMapFacilities(kinds, query, origin, baseline), [kinds, query, origin, baseline]);

  useEffect(() => {
    if (!map) return;
    map.addSource("osm-facilities", { type: "geojson", data: { type: "FeatureCollection", features: [] }, cluster: true, clusterRadius: 35, clusterMaxZoom: 13 });
    map.addLayer({ id: "osm-facilities", type: "circle", source: "osm-facilities", filter: ["!", ["has", "point_count"]], paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3, 16, 7],
      "circle-color": ["match", ["get", "kind"], "HOSPITAL", facilityKinds.HOSPITAL.color, "POLICE", facilityKinds.POLICE.color, "FIRE_STATION", facilityKinds.FIRE_STATION.color, "SCHOOL", facilityKinds.SCHOOL.color, "COLLEGE", facilityKinds.COLLEGE.color, "COMMUNITY_CENTRE", facilityKinds.COMMUNITY_CENTRE.color, "#064b9c"],
      "circle-stroke-color": "#ffffff", "circle-stroke-width": 2,
    } });
    map.addLayer({ id: "osm-facility-groups", type: "circle", source: "osm-facilities", filter: ["has", "point_count"], paint: {
      "circle-radius": ["step", ["get", "point_count"], 8, 100, 12, 1000, 16],
      "circle-color": "#064b9c", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2,
    } });
    let disposed = false;
    const layers = ["osm-facilities", "osm-facility-groups"];
    const updateCenter = () => { const center = map.getCenter(); setOrigin([center.lng, center.lat]); };
    const click = (event: MapMouseEvent) => {
      const hit = map.queryRenderedFeatures(event.point, { layers })[0];
      if (hit?.properties.cluster && hit.geometry.type === "Point") {
        const generation = requestRef.current;
        const coordinates = hit.geometry.coordinates.slice(0, 2) as MapPosition;
        void (map.getSource("osm-facilities") as GeoJSONSource).getClusterExpansionZoom(Number(hit.properties.cluster_id))
          .then((zoom) => { if (!disposed && generation === requestRef.current) map.easeTo({ center: coordinates, zoom, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 400 }); })
          .catch(() => { if (!disposed && generation === requestRef.current) { setError("Could not expand this group. Zoom in or search for a place."); setOpen(true); } });
        return;
      }
      const id = hit?.properties.id;
      const feature = baselineRef.current.features.find((item) => item.id === id);
      if (feature) { setSelected(feature); setOpen(true); }
    };
    const enter = () => { map.getCanvas().style.cursor = "pointer"; };
    const leave = () => { map.getCanvas().style.cursor = ""; };
    updateCenter();
    map.on("moveend", updateCenter);
    map.on("click", layers, click);
    map.on("mouseenter", layers, enter);
    map.on("mouseleave", layers, leave);
    return () => {
      disposed = true;
      map.off("moveend", updateCenter);
      map.off("click", layers, click);
      map.off("mouseenter", layers, enter);
      map.off("mouseleave", layers, leave);
      if (map.getLayer("osm-facility-groups")) map.removeLayer("osm-facility-groups");
      if (map.getLayer("osm-facilities")) map.removeLayer("osm-facilities");
      if (map.getSource("osm-facilities")) map.removeSource("osm-facilities");
    };
  }, [map]);

  useEffect(() => {
    (map?.getSource("osm-facilities") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: filtered });
  }, [map, filtered]);

  useEffect(() => {
    if (selected && !filtered.some((feature) => feature.id === selected.id)) setSelected(null);
  }, [filtered, selected]);

  useEffect(() => {
    if (map?.getLayer("osm-facilities")) map.setPaintProperty("osm-facilities", "circle-stroke-color", ["match", ["get", "id"], selected?.id ?? "", "#111827", "#ffffff"]);
  }, [map, selected]);

  useEffect(() => { baselineRef.current = baseline; }, [baseline]);
  useEffect(() => () => { requestRef.current += 1; }, []);
  const changeRegion = async (next: "chennai" | "kerala") => {
    const request = ++requestRef.current;
    setLoading(true); setError("");
    try {
      let data = facilityBaseline;
      if (next === "kerala") {
        const url = (await import("../../../fixtures/regions/in-kl/osm-places.geojson?url")).default;
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("Baseline unavailable");
        data = await response.json() as FacilityBaseline;
      }
      if (request !== requestRef.current) return;
      setBaseline(data); setRegion(next); setSelected(null); setQuery(""); onRegionChange(next);
      const bounds: [[number, number], [number, number]] = next === "kerala" ? [[74.8, 8.1], [77.5, 12.9]] : [[80.145, 12.875], [80.315, 13.075]];
      map?.setMinZoom(next === "kerala" ? 5 : 10.5);
      map?.setMaxBounds(bounds);
      map?.fitBounds(bounds, { padding: 30, duration: 0 });
    } catch { if (request === requestRef.current) setError("Could not load this region. Check your connection and try again."); }
    finally { if (request === requestRef.current) setLoading(false); }
  };
  const close = () => { setOpen(false); toggleRef.current?.focus(); };
  const choose = (feature: Facility) => {
    setSelected(feature);
    map?.flyTo({ center: feature.geometry.coordinates, zoom: 16, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600 });
  };

  return <div className="fr-map-facilities">
    <button ref={toggleRef} type="button" className="fr-map-facilities-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>Places · {matches.length}</button>
    {open && <section id={panelId} className="fr-map-facilities-panel" aria-label="OpenStreetMap places" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
      <div className="fr-map-facilities-heading"><strong>{region === "kerala" ? "Kerala" : "Chennai"} places</strong><button type="button" onClick={close} aria-label="Close places">×</button></div>
      {allowRegionSwitch && <label>Region<select aria-label="Region" value={region} disabled={loading || !map} onChange={(event) => void changeRegion(event.target.value as "chennai" | "kerala")}><option value="chennai">Chennai pilot area</option><option value="kerala">Kerala statewide</option></select></label>}
      {loading && <p role="status">Loading mapped places…</p>}{error && <p role="alert">{error}</p>}
      <label>Find a mapped place<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name in any mapped language" /></label>
      <fieldset><legend>Show on map</legend>{(Object.keys(facilityKinds) as FacilityKind[]).map((kind) => <label key={kind}>
        <input type="checkbox" checked={kinds.includes(kind)} onChange={(event) => setKinds(event.target.checked ? [...kinds, kind] : kinds.filter((value) => value !== kind))} />
        <span style={{ background: facilityKinds[kind].color }} aria-hidden="true" />{facilityKinds[kind].label}
      </label>)}</fieldset>
      <p>OSM snapshot {baseline.source_snapshot_at.slice(0, 10)}. Availability and access unverified. Schools and halls are not activated shelters. Grouped blue dots expand when selected.</p>
      {selected && <div className="fr-map-facility-detail" aria-live="polite"><strong>{selected.properties.name}</strong><span>{facilityKinds[selected.properties.kind].label} · {selected.geometry.coordinates[1].toFixed(5)}, {selected.geometry.coordinates[0].toFixed(5)}</span><a href={facilitySourceUrl(selected)} target="_blank" rel="noreferrer">View OpenStreetMap record ↗</a></div>}
      <p role="status">{matches.length} mapped places · nearest to map centre first · straight-line distances</p>
      <ul>{matches.slice(0, 20).map((feature) => <li key={feature.id}><button type="button" aria-pressed={selected?.id === feature.id} onClick={() => choose(feature)}><strong>{feature.properties.name}</strong><span>{facilityKinds[feature.properties.kind].label} · {(facilityDistance(feature, origin) / 1000).toFixed(1)} km</span></button></li>)}</ul>
      {matches.length === 0 && <p>Select a category or try another name.</p>}
      {matches.length > 20 && <p>Showing nearest 20. Search or move the map to find others.</p>}
    </section>}
  </div>;
}
