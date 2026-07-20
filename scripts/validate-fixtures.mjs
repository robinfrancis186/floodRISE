import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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

console.log(
  `Validated ${manifest.files.length} fixture files, ${rasterManifest.artifacts.length} raster artifacts, and ${osmBaseline.features.length} OSM road segments for ${manifest.scenario_id}.`,
);
