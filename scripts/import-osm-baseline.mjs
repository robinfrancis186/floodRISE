import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AOI = Object.freeze({ south: 9.92, west: 76.2, north: 10.24, east: 76.48 });
// Overpass returns complete ways intersecting the query AOI, so their terminal
// nodes can legitimately extend beyond the request box. This reviewed capture
// boundary contains the full Kerala pilot road corridors without accepting
// arbitrary global coordinates.
const GEOMETRY_BOUNDS = Object.freeze({
  south: 9.8,
  west: 76.08,
  north: 10.36,
  east: 76.6,
});
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;
const MAX_ELEMENTS = 20_000;
const MAX_POINTS_PER_WAY = 5_000;
const ALLOWED_ENDPOINTS = new Set([
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
]);
const ALLOWED_HIGHWAYS = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
]);

export function validateOverpassEndpoint(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || !ALLOWED_ENDPOINTS.has(url.href)
  ) {
    throw new Error("Overpass endpoint must be an allow-listed HTTPS API URL.");
  }
  return url.href;
}

export async function readBoundedJson(response, maximumBytes = MAX_RESPONSE_BYTES) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`Overpass response exceeds the ${maximumBytes}-byte limit.`);
  }
  if (!response.body) throw new Error("Overpass response body is unavailable.");

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel("response limit exceeded");
      throw new Error(`Overpass response exceeds the ${maximumBytes}-byte limit.`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

function safeOptionalTag(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:;,+/ ()-]{1,120}$/.test(value)) {
    throw new Error(`OpenStreetMap ${field} tag is invalid.`);
  }
  return value;
}

function safeRoadName(value, highway, wayId) {
  if (value === undefined || value === null || value === "") {
    return `Unnamed ${roadClass(highway)} road · OSM ${wayId}`;
  }
  if (
    typeof value !== "string"
    || value.length > 120
    || !/^[^\u0000-\u001F\u007F<>{}]{1,120}$/u.test(value)
  ) {
    throw new Error("OpenStreetMap road name is invalid.");
  }
  return value.trim();
}

function normalizedSnapshotTime(payload) {
  const value = payload.osm3s?.timestamp_osm_base;
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string"
    || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("OpenStreetMap snapshot timestamp is invalid.");
  }
  return value;
}

function roadClass(highway) {
  if (highway === "trunk" || highway === "trunk_link") return "trunk";
  if (highway === "primary" || highway === "primary_link") return "primary";
  if (highway === "secondary" || highway === "secondary_link") return "secondary";
  return "local";
}

export function normalizeOverpassPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("OpenStreetMap response must be a JSON object.");
  }
  if (!Array.isArray(payload.elements) || payload.elements.length > MAX_ELEMENTS) {
    throw new Error("OpenStreetMap response has an invalid element collection.");
  }

  const seenWayIds = new Set();
  const features = [];
  for (const element of payload.elements) {
    if (!element || typeof element !== "object" || element.type !== "way") continue;
    if (!Number.isSafeInteger(element.id) || element.id <= 0 || seenWayIds.has(element.id)) {
      throw new Error("OpenStreetMap way identifier is invalid or duplicated.");
    }
    const highway = element.tags?.highway;
    if (
      typeof highway !== "string"
      || !/^[a-z_]{1,32}$/.test(highway)
      || !ALLOWED_HIGHWAYS.has(highway)
    ) {
      throw new Error("OpenStreetMap highway tag is invalid.");
    }
    const name = safeRoadName(element.tags?.name, highway, element.id);
    if (
      !Array.isArray(element.geometry)
      || element.geometry.length < 2
      || element.geometry.length > MAX_POINTS_PER_WAY
    ) {
      throw new Error("OpenStreetMap way geometry is invalid.");
    }

    const coordinates = element.geometry.map((point) => {
      if (!point || typeof point !== "object") {
        throw new Error("OpenStreetMap coordinate is invalid.");
      }
      const { lon, lat } = point;
      if (
        !Number.isFinite(lon)
        || !Number.isFinite(lat)
        || lon < GEOMETRY_BOUNDS.west
        || lon > GEOMETRY_BOUNDS.east
        || lat < GEOMETRY_BOUNDS.south
        || lat > GEOMETRY_BOUNDS.north
      ) {
        throw new Error("OpenStreetMap coordinate falls outside the approved Kerala AOI.");
      }
      return [Number(lon.toFixed(7)), Number(lat.toFixed(7))];
    });

    seenWayIds.add(element.id);
    features.push({
      type: "Feature",
      id: `osm-way-${element.id}`,
      geometry: { type: "LineString", coordinates },
      properties: {
        id: `osm-way-${element.id}`,
        kind: "route",
        name,
        description: `OpenStreetMap ${highway.replaceAll("_", " ")} road segment`,
        class: roadClass(highway),
        osm_type: "way",
        osm_id: String(element.id),
        highway,
        bridge: safeOptionalTag(element.tags.bridge, "bridge"),
        tunnel: safeOptionalTag(element.tags.tunnel, "tunnel"),
        layer: safeOptionalTag(element.tags.layer, "layer"),
        surface: safeOptionalTag(element.tags.surface, "surface"),
        source: "OpenStreetMap",
        source_url: `https://www.openstreetmap.org/way/${element.id}`,
        attribution: "© OpenStreetMap contributors",
        licence: "Open Data Commons Open Database License (ODbL) 1.0",
        is_simulated: false,
      },
    });
  }

  features.sort((left, right) => left.properties.osm_id.localeCompare(
    right.properties.osm_id,
    "en",
    { numeric: true },
  ));
  return {
    snapshotTime: normalizedSnapshotTime(payload),
    features,
  };
}

export function buildMapFallback(features, maximumFeatures = 800) {
  if (!Array.isArray(features) || !Number.isSafeInteger(maximumFeatures) || maximumFeatures < 1) {
    throw new Error("OpenStreetMap fallback inputs are invalid.");
  }
  const priority = new Map([
    ["motorway", 0], ["motorway_link", 0],
    ["trunk", 1], ["trunk_link", 1],
    ["primary", 2], ["primary_link", 2],
    ["secondary", 3], ["secondary_link", 3],
    ["tertiary", 4], ["tertiary_link", 4],
  ]);
  const centerLongitude = (AOI.west + AOI.east) / 2;
  const centerLatitude = (AOI.south + AOI.north) / 2;
  const distanceFromCenter = (feature) => {
    const points = feature.geometry.coordinates;
    const midpoint = points[Math.floor(points.length / 2)];
    return (midpoint[0] - centerLongitude) ** 2 + (midpoint[1] - centerLatitude) ** 2;
  };

  return [...features]
    .sort((left, right) => (
      (priority.get(left.properties.highway) ?? 99)
      - (priority.get(right.properties.highway) ?? 99)
      || distanceFromCenter(left) - distanceFromCenter(right)
      || left.properties.osm_id.localeCompare(right.properties.osm_id, "en", { numeric: true })
    ))
    .slice(0, maximumFeatures)
    .map((feature) => ({
      ...feature,
      properties: {
        id: feature.properties.id,
        kind: feature.properties.kind,
        name: feature.properties.name,
        description: feature.properties.description,
        class: feature.properties.class,
        osm_id: feature.properties.osm_id,
        highway: feature.properties.highway,
        bridge: feature.properties.bridge,
        tunnel: feature.properties.tunnel,
        source: feature.properties.source,
        is_simulated: false,
      },
    }));
}

async function writeAtomically(outputPath, serialized) {
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    // The network response has been size-bounded and rebuilt from allow-listed
    // validated OSM names, finite AOI coordinates, scalar tags, and a fixed output path.
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
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const outputPath = join(root, "fixtures", "kerala-demo", "osm-baseline.geojson");
  const fallbackPath = join(root, "fixtures", "kerala-demo", "osm-map-fallback.geojson");
  if (process.argv.includes("--from-existing")) {
    const existing = JSON.parse(await readFile(outputPath, "utf8"));
    if (existing.type !== "FeatureCollection" || !Array.isArray(existing.features)) {
      throw new Error("Existing OpenStreetMap baseline is invalid.");
    }
    const fallback = {
      ...existing,
      name: "floodRISE Kerala OSM application fallback",
      description: "Bounded application subset; the complete imported snapshot is osm-baseline.geojson",
      features: buildMapFallback(existing.features),
    };
    const serialized = `${JSON.stringify(fallback)}\n`;
    await writeAtomically(fallbackPath, serialized);
    console.log(`Wrote ${fallback.features.length} OSM fallback segments to ${fallbackPath}`);
    console.log(`Fallback SHA-256: ${createHash("sha256").update(serialized).digest("hex")}`);
    return;
  }
  const endpoint = validateOverpassEndpoint(
    process.env.FLOODRISE_OVERPASS_URL ?? "https://overpass-api.de/api/interpreter",
  );
  const bbox = `${AOI.south},${AOI.west},${AOI.north},${AOI.east}`;
  const query = `[out:json][timeout:60];way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](${bbox});out tags geom;`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "User-Agent": "floodRISE-competition-fixture/0.2 (Kerala OSM snapshot importer)",
    },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(75_000),
  });
  validateOverpassEndpoint(response.url);
  if (!response.ok) {
    throw new Error(`OpenStreetMap Overpass import failed: ${response.status} ${response.statusText}`);
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("OpenStreetMap Overpass response was not JSON.");
  }

  const payload = await readBoundedJson(response);
  const { features, snapshotTime } = normalizeOverpassPayload(payload);
  if (features.length < 100) {
    throw new Error(`OpenStreetMap import returned only ${features.length} road segments; refusing to replace the fixture.`);
  }

  const collection = {
    type: "FeatureCollection",
    name: "floodRISE Kerala OSM road baseline",
    source: "OpenStreetMap via Overpass API; production imports use Geofabrik Southern Zone extracts",
    source_url: "https://www.openstreetmap.org",
    source_snapshot_at: snapshotTime,
    attribution: "© OpenStreetMap contributors",
    licence: "Open Data Commons Open Database License (ODbL) 1.0",
    bbox: [AOI.west, AOI.south, AOI.east, AOI.north],
    features,
  };
  const serialized = `${JSON.stringify(collection, null, 2)}\n`;
  const fallback = {
    ...collection,
    name: "floodRISE Kerala OSM application fallback",
    description: "Bounded application subset; the complete imported snapshot is osm-baseline.geojson",
    features: buildMapFallback(features),
  };
  const fallbackSerialized = `${JSON.stringify(fallback)}\n`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeAtomically(outputPath, serialized);
  await writeAtomically(fallbackPath, fallbackSerialized);
  const checksum = createHash("sha256").update(serialized).digest("hex");
  const fallbackChecksum = createHash("sha256").update(fallbackSerialized).digest("hex");
  console.log(`Wrote ${features.length} OSM road segments to ${outputPath}`);
  console.log(`Wrote ${fallback.features.length} OSM fallback segments to ${fallbackPath}`);
  console.log(`Snapshot: ${snapshotTime ?? "unknown"}`);
  console.log(`SHA-256: ${checksum}`);
  console.log(`Fallback SHA-256: ${fallbackChecksum}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
