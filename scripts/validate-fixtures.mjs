import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = join(root, "fixtures", "chennai-demo");
const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8"));

if (manifest.is_simulated !== true || manifest.live_integrations_enabled !== false) {
  throw new Error("Demo manifest must be simulated with live integrations disabled.");
}
if (!String(manifest.alert_gateway).startsWith("fake://")) {
  throw new Error("Demo manifest must use a fake alert gateway.");
}

for (const entry of manifest.files) {
  const payload = await readFile(join(fixtureRoot, entry.path));
  const digest = createHash("sha256").update(payload).digest("hex");
  if (digest !== entry.sha256) {
    throw new Error(`Checksum mismatch for ${entry.path}: expected ${entry.sha256}, got ${digest}`);
  }
}

const rasterManifestPath = join(fixtureRoot, "rasters", "manifest.json");
const rasterManifest = JSON.parse(await readFile(rasterManifestPath, "utf8"));
if (
  rasterManifest.schema_version !== "floodrise-packaged-raster/v1" ||
  rasterManifest.is_simulated !== true ||
  rasterManifest.data_label !== "DEMO DATA" ||
  rasterManifest.representation !== "PACKAGED_PGM"
) {
  throw new Error("Raster manifest must be the labeled, packaged deterministic demo format.");
}
if (!Array.isArray(rasterManifest.artifacts) || rasterManifest.artifacts.length === 0) {
  throw new Error("Raster manifest must list at least one artifact.");
}
const rasterRoot = dirname(rasterManifestPath);
const artifactIds = new Set();
for (const artifact of rasterManifest.artifacts) {
  if (artifactIds.has(artifact.id)) {
    throw new Error(`Duplicate raster artifact id: ${artifact.id}`);
  }
  artifactIds.add(artifact.id);
  const artifactPath = join(rasterRoot, artifact.path);
  if (dirname(artifactPath) !== rasterRoot) {
    throw new Error(
      `Raster artifact path must stay in the raster fixture directory: ${artifact.path}`,
    );
  }
  const payload = await readFile(artifactPath);
  const digest = createHash("sha256").update(payload).digest("hex");
  if (digest !== artifact.content_sha256) {
    throw new Error(
      `Checksum mismatch for raster ${artifact.path}: expected ${artifact.content_sha256}, got ${digest}`,
    );
  }
}

const reports = JSON.parse(await readFile(join(fixtureRoot, "reports.json"), "utf8"));
if (reports.some((report) => report.is_simulated !== true)) {
  throw new Error("Every demo report must carry is_simulated=true.");
}
const independent = reports.filter(
  (report) => report.claim === "FLOOD_PRESENT" && !report.expected_disposition,
);
if (new Set(independent.map((report) => report.device_id)).size < 4) {
  throw new Error("Demo fixture must contain four independent eligible report devices.");
}

const osmBaseline = JSON.parse(
  await readFile(join(fixtureRoot, "osm-baseline.geojson"), "utf8"),
);
if (
  osmBaseline.type !== "FeatureCollection" ||
  osmBaseline.features.length < 20 ||
  osmBaseline.attribution !== "© OpenStreetMap contributors" ||
  !String(osmBaseline.licence).includes("ODbL")
) {
  throw new Error("OSM baseline must be a populated, visibly attributed ODbL snapshot.");
}
if (
  osmBaseline.features.some(
    (feature) =>
      feature.properties?.source !== "OpenStreetMap" ||
      feature.properties?.is_simulated !== false ||
      !feature.properties?.osm_id,
  )
) {
  throw new Error("Every OSM road feature must retain source identity and non-simulated status.");
}

const osmPlaces = JSON.parse(await readFile(join(fixtureRoot, "osm-places.geojson"), "utf8"));
if (
  osmPlaces.type !== "FeatureCollection" ||
  osmPlaces.attribution !== "© OpenStreetMap contributors" ||
  !String(osmPlaces.licence).includes("ODbL") ||
  !String(osmPlaces.notice).includes("Not an activated shelter list")
) {
  throw new Error("OSM places must be an attributed ODbL snapshot carrying the shelter notice.");
}
if (osmPlaces.features.filter((feature) => feature.properties?.kind === "HOSPITAL").length < 3) {
  throw new Error("OSM places must include mapped hospitals.");
}
// Region bundles carry facility locations only; each pins its own checksums.
const regionsRoot = join(root, "fixtures", "regions");
let regionPlaces = 0;
for (const regionId of (await readdir(regionsRoot)).sort()) {
  const regionRoot = join(regionsRoot, regionId);
  const regionManifest = JSON.parse(await readFile(join(regionRoot, "manifest.json"), "utf8"));
  if (regionManifest.region_id !== regionId || regionManifest.is_simulated !== false) {
    throw new Error(`Region manifest ${regionId} must name its region and be non-simulated source data.`);
  }
  for (const entry of regionManifest.files) {
    const digest = createHash("sha256").update(await readFile(join(regionRoot, entry.path))).digest("hex");
    if (digest !== entry.sha256) {
      throw new Error(`Checksum mismatch for regions/${regionId}/${entry.path}.`);
    }
  }
  const places = JSON.parse(await readFile(join(regionRoot, "osm-places.geojson"), "utf8"));
  const [west, south, east, north] = places.bbox;
  if (
    places.attribution !== "© OpenStreetMap contributors" ||
    !String(places.licence).includes("ODbL") ||
    !String(places.notice).includes("Not an activated shelter list") ||
    places.features.some((feature) => {
      const [longitude, latitude] = feature.geometry?.coordinates ?? [];
      return (
        !/^osm-(node|way)-\d+$/.test(feature.id) ||
        !(longitude >= west && longitude <= east && latitude >= south && latitude <= north) ||
        feature.properties?.is_simulated !== false ||
        !feature.properties?.name ||
        !feature.properties?.kind
      );
    })
  ) {
    throw new Error(`Region ${regionId} places must be attributed, named, in-area OSM points.`);
  }
  regionPlaces += places.features.length;
}

const [placeWest, placeSouth, placeEast, placeNorth] = osmPlaces.bbox;
if (
  osmPlaces.features.some((feature) => {
    const [longitude, latitude] = feature.geometry?.coordinates ?? [];
    return (
      feature.geometry?.type !== "Point" ||
      !(longitude >= placeWest && longitude <= placeEast) ||
      !(latitude >= placeSouth && latitude <= placeNorth) ||
      feature.properties?.is_simulated !== false ||
      !feature.properties?.osm_id ||
      !feature.properties?.name
    );
  })
) {
  throw new Error("Every OSM place must be a named, in-area point with source identity.");
}

console.log(
  `Validated ${manifest.files.length} fixture files, ${rasterManifest.artifacts.length} raster artifacts, ${osmPlaces.features.length} OSM places (plus ${regionPlaces} in region bundles), and ${osmBaseline.features.length} OSM road segments for ${manifest.scenario_id}.`,
);
