import { createHash } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedJson, validateOverpassEndpoint } from "./import-osm-baseline.mjs";

// Each region pins its own reviewed bounds, Overpass selector, output path, and
// size limits. Chennai uses the same pilot AOI as the road baseline importer;
// Kerala is selected by its state boundary and bounds-checked as a sanity guard.
export const REGIONS = Object.freeze({
  chennai: Object.freeze({
    name: "floodRISE Chennai OSM facility baseline",
    bounds: Object.freeze({ south: 12.9, west: 80.17, north: 13.05, east: 80.29 }),
    selector: (filter) => `nwr${filter}(12.9,80.17,13.05,80.29);`,
    output: ["fixtures", "chennai-demo", "osm-places.geojson"],
    maxElements: 20_000,
    maxBytes: 15 * 1024 * 1024,
    minimumPlaces: 20,
    compact: false,
  }),
  kerala: Object.freeze({
    name: "floodRISE Kerala OSM facility baseline",
    bounds: Object.freeze({ south: 8.1, west: 74.8, north: 12.9, east: 77.5 }),
    selector: (filter) =>
      `area["ISO3166-2"="IN-KL"]["admin_level"="4"]->.state;nwr${filter}(area.state);`,
    output: ["fixtures", "regions", "in-kl", "osm-places.geojson"],
    maxElements: 60_000,
    maxBytes: 60 * 1024 * 1024,
    minimumPlaces: 5_000,
    // Statewide snapshots drop null and derivable properties to stay small.
    compact: true,
  }),
});
const MAX_NAME_LENGTH = 120;
const ATTRIBUTION = "© OpenStreetMap contributors";
const LICENCE = "Open Data Commons Open Database License (ODbL) 1.0";

// OSM amenity value -> floodRISE facility kind. Schools, colleges, and community
// centres are only *candidate* relief sites: an authority must activate and
// verify a shelter before floodRISE may present it as one.
const KIND_BY_AMENITY = Object.freeze({
  hospital: "HOSPITAL",
  fire_station: "FIRE_STATION",
  police: "POLICE",
  school: "SCHOOL",
  college: "COLLEGE",
  community_centre: "COMMUNITY_CENTRE",
});
export const FACILITY_KINDS = Object.freeze([...new Set(Object.values(KIND_BY_AMENITY))].sort());

function cleanName(value) {
  if (typeof value !== "string") return null;
  // Names are free text in many scripts; drop control and bidi-override
  // characters and bound the length instead of restricting the alphabet.
  const cleaned = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 && cleaned.length <= MAX_NAME_LENGTH ? cleaned : null;
}

function position(element, bounds) {
  const point = element.type === "node" ? element : element.center;
  if (!point || typeof point !== "object") return null;
  const { lon, lat } = point;
  if (
    !Number.isFinite(lon)
    || !Number.isFinite(lat)
    || lon < bounds.west
    || lon > bounds.east
    || lat < bounds.south
    || lat > bounds.north
  ) {
    return null;
  }
  return [Number(lon.toFixed(6)), Number(lat.toFixed(6))];
}

function snapshotTime(payload) {
  const value = payload.osm3s?.timestamp_osm_base;
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("OpenStreetMap snapshot timestamp is invalid.");
  }
  return value;
}

export function normalizePlacesPayload(payload, region = REGIONS.chennai) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("OpenStreetMap response must be a JSON object.");
  }
  if (!Array.isArray(payload.elements) || payload.elements.length > region.maxElements) {
    throw new Error("OpenStreetMap response has an invalid element collection.");
  }

  const seen = new Set();
  const features = [];
  for (const element of payload.elements) {
    if (!element || typeof element !== "object") continue;
    if (element.type !== "node" && element.type !== "way") continue;
    const kind = KIND_BY_AMENITY[element.tags?.amenity];
    if (!kind) continue;
    if (!Number.isSafeInteger(element.id) || element.id <= 0) {
      throw new Error("OpenStreetMap element identifier is invalid.");
    }
    const id = `osm-${element.type}-${element.id}`;
    if (seen.has(id)) throw new Error("OpenStreetMap element identifier is duplicated.");
    // Unnamed or out-of-area features cannot be shown usefully; skip them
    // rather than failing the whole import.
    const name = cleanName(element.tags.name) ?? cleanName(element.tags["name:en"]);
    const coordinates = position(element, region.bounds);
    if (!name || !coordinates) continue;

    seen.add(id);
    const properties = {
      id,
      kind,
      name,
      name_en: cleanName(element.tags["name:en"]),
      name_ta: cleanName(element.tags["name:ta"]),
      name_hi: cleanName(element.tags["name:hi"]),
      name_ml: cleanName(element.tags["name:ml"]),
      emergency: element.tags.emergency === "yes" ? true : null,
      osm_type: element.type,
      osm_id: String(element.id),
      source: "OpenStreetMap",
      source_url: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      is_simulated: false,
    };
    if (region.compact) {
      // id, source, and source_url are derivable from the feature id.
      for (const key of ["id", "source", "source_url"]) delete properties[key];
      for (const [key, value] of Object.entries(properties)) {
        if (value === null || (key === "name_en" && value === name)) delete properties[key];
      }
    }
    features.push({ type: "Feature", id, geometry: { type: "Point", coordinates }, properties });
  }

  features.sort((left, right) => left.id.localeCompare(right.id, "en", { numeric: true }));
  return { snapshotTime: snapshotTime(payload), features };
}

async function writeAtomically(outputPath, serialized) {
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    // The response is size-bounded and rebuilt from allow-listed amenity
    // kinds, AOI-checked coordinates, sanitized names, and a fixed output path.
    // codeql[js/http-to-file-access]
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function main() {
  const regionKey = process.argv[2] ?? "chennai";
  const region = REGIONS[regionKey];
  if (!Object.hasOwn(REGIONS, regionKey)) {
    throw new Error(`Unknown region "${regionKey}". Supported: ${Object.keys(REGIONS).join(", ")}.`);
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const outputPath = join(root, ...region.output);
  const endpoint = validateOverpassEndpoint(
    process.env.FLOODRISE_OVERPASS_URL ?? "https://overpass-api.de/api/interpreter",
  );
  const amenities = Object.keys(KIND_BY_AMENITY).join("|");
  const filter = `["amenity"~"^(${amenities})$"]["name"]`;
  const query = `[out:json][timeout:170][maxsize:536870912];${region.selector(filter)}out tags center;`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "User-Agent": "floodRISE-competition-fixture/0.1 (offline OSM snapshot importer)",
    },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(200_000),
  });
  validateOverpassEndpoint(response.url);
  if (!response.ok) {
    throw new Error(`OpenStreetMap Overpass import failed: ${response.status} ${response.statusText}`);
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("OpenStreetMap Overpass response was not JSON.");
  }

  const { features, snapshotTime: capturedAt } = normalizePlacesPayload(
    await readBoundedJson(response, region.maxBytes),
    region,
  );
  const hospitals = features.filter((feature) => feature.properties.kind === "HOSPITAL").length;
  if (features.length < region.minimumPlaces || hospitals < 3) {
    throw new Error(
      `OpenStreetMap import returned ${features.length} places (${hospitals} hospitals); refusing to replace the fixture.`,
    );
  }

  const collection = {
    type: "FeatureCollection",
    name: region.name,
    source: "OpenStreetMap via Overpass API",
    source_url: "https://www.openstreetmap.org",
    source_snapshot_at: capturedAt,
    attribution: ATTRIBUTION,
    licence: LICENCE,
    notice:
      "Mapped locations only. Not an activated shelter list, and not a statement that a facility is open, reachable, or has capacity.",
    bbox: [region.bounds.west, region.bounds.south, region.bounds.east, region.bounds.north],
    features,
  };
  const serialized = `${JSON.stringify(collection)}\n`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeAtomically(outputPath, serialized);
  console.log(`Wrote ${features.length} OSM places (${hospitals} hospitals) to ${outputPath}`);
  console.log(`Snapshot: ${capturedAt ?? "unknown"}`);
  console.log(`SHA-256: ${createHash("sha256").update(serialized).digest("hex")}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
