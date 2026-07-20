import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(root, "fixtures", "chennai-demo", "osm-baseline.geojson");
const endpoint = process.env.FLOODRISE_OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
const bbox = "12.90,80.17,13.05,80.29";
const roadNames = [
  "100 Feet Road",
  "Anna Salai (Mount Road)",
  "Dr MGR Main Road",
  "Inner Ring Road",
  "Old Mahabalipuram Road",
  "Pallikaranai Main Road",
  "Rajiv Gandhi Salai",
  "Sardar Patel Road",
  "Taramani Link Road",
  "Velachery Bypass Road",
  "Velachery Main Road",
  "Velachery Mudhanmai Salai",
];

const selectors = roadNames
  .map((name) => `way["highway"]["name"="${name}"](${bbox});`)
  .join("\n");
const query = `[out:json][timeout:60];(\n${selectors}\n);out tags geom;`;
const body = new URLSearchParams({ data: query });
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "User-Agent": "floodRISE-competition-fixture/0.1 (offline OSM snapshot importer)",
  },
  body,
});
if (!response.ok) {
  throw new Error(`OpenStreetMap Overpass import failed: ${response.status} ${response.statusText}`);
}

const payload = await response.json();
const roadClass = (highway) => {
  if (highway === "trunk" || highway === "trunk_link") return "trunk";
  if (highway === "primary" || highway === "primary_link") return "primary";
  if (highway === "secondary" || highway === "secondary_link") return "secondary";
  return "local";
};
const features = payload.elements
  .filter((element) => element.type === "way" && element.tags?.highway && element.geometry?.length > 1)
  .map((element) => ({
    type: "Feature",
    id: `osm-way-${element.id}`,
    geometry: {
      type: "LineString",
      coordinates: element.geometry.map(({ lon, lat }) => [lon, lat]),
    },
    properties: {
      id: `osm-way-${element.id}`,
      kind: "route",
      name: element.tags.name,
      description: `OpenStreetMap ${element.tags.highway.replaceAll("_", " ")} road segment`,
      class: roadClass(element.tags.highway),
      osm_type: "way",
      osm_id: String(element.id),
      highway: element.tags.highway,
      bridge: element.tags.bridge ?? null,
      tunnel: element.tags.tunnel ?? null,
      layer: element.tags.layer ?? null,
      surface: element.tags.surface ?? null,
      source: "OpenStreetMap",
      source_url: `https://www.openstreetmap.org/way/${element.id}`,
      attribution: "© OpenStreetMap contributors",
      licence: "Open Data Commons Open Database License (ODbL) 1.0",
      is_simulated: false,
    },
  }))
  .sort((left, right) => left.properties.osm_id.localeCompare(right.properties.osm_id, "en", { numeric: true }));

if (features.length < 20) {
  throw new Error(`OpenStreetMap import returned only ${features.length} road segments; refusing to replace the fixture.`);
}

const collection = {
  type: "FeatureCollection",
  name: "floodRISE Chennai OSM road baseline",
  source: "OpenStreetMap via Overpass API; production imports use Geofabrik Southern Zone extracts",
  source_url: "https://www.openstreetmap.org",
  source_snapshot_at: payload.osm3s?.timestamp_osm_base ?? null,
  attribution: "© OpenStreetMap contributors",
  licence: "Open Data Commons Open Database License (ODbL) 1.0",
  bbox: [80.17, 12.90, 80.29, 13.05],
  features,
};
const serialized = `${JSON.stringify(collection, null, 2)}\n`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, serialized, "utf8");
const checksum = createHash("sha256").update(serialized).digest("hex");
console.log(`Wrote ${features.length} OSM road segments to ${outputPath}`);
console.log(`Snapshot: ${collection.source_snapshot_at ?? "unknown"}`);
console.log(`SHA-256: ${checksum}`);
