/// <reference path="../geojson.d.ts" />

import type {
  ChennaiMapData,
  MapFeature,
  MapFeatureCollection,
  MapFeatureProperties,
  MapPosition,
} from "../types";
import osmBaselineSource from "../../../../fixtures/chennai-demo/osm-baseline.geojson?raw";

type PointGeometry = { type: "Point"; coordinates: MapPosition };
type LineGeometry = { type: "LineString"; coordinates: MapPosition[] };
type PolygonGeometry = { type: "Polygon"; coordinates: MapPosition[][] };

const collection = <G extends PointGeometry | LineGeometry | PolygonGeometry>(
  features: Array<MapFeature<G>>,
): MapFeatureCollection<G> => ({ type: "FeatureCollection", features });

const mixedCollection = (
  features: Array<
    MapFeature<PointGeometry> | MapFeature<LineGeometry> | MapFeature<PolygonGeometry>
  >,
): MapFeatureCollection => ({ type: "FeatureCollection", features });

const point = (
  coordinates: MapPosition,
  properties: MapFeatureProperties,
): MapFeature<PointGeometry> => ({
  type: "Feature",
  id: properties.id,
  geometry: { type: "Point", coordinates },
  properties,
});

const line = (
  coordinates: MapPosition[],
  properties: MapFeatureProperties,
): MapFeature<LineGeometry> => ({
  type: "Feature",
  id: properties.id,
  geometry: { type: "LineString", coordinates },
  properties,
});

const polygon = (
  coordinates: MapPosition[],
  properties: MapFeatureProperties,
): MapFeature<PolygonGeometry> => ({
  type: "Feature",
  id: properties.id,
  geometry: { type: "Polygon", coordinates: [coordinates] },
  properties,
});

const wards = collection([
  polygon(
    [
      [80.197, 13.001], [80.222, 13.004], [80.233, 12.989], [80.228, 12.966],
      [80.207, 12.961], [80.191, 12.978], [80.197, 13.001],
    ],
    { id: "ward-177", kind: "ward", name: "Velachery", description: "Ward 177", class: "ward-a" },
  ),
  polygon(
    [
      [80.195, 13.035], [80.224, 13.038], [80.239, 13.018], [80.222, 13.004],
      [80.197, 13.001], [80.188, 13.019], [80.195, 13.035],
    ],
    { id: "ward-142", kind: "ward", name: "Saidapet", description: "Ward 142", class: "ward-b" },
  ),
  polygon(
    [
      [80.224, 13.038], [80.269, 13.039], [80.279, 13.012], [80.253, 12.997],
      [80.239, 13.018], [80.224, 13.038],
    ],
    { id: "ward-174", kind: "ward", name: "Adyar", description: "Ward 174", class: "ward-a" },
  ),
  polygon(
    [
      [80.207, 12.961], [80.228, 12.966], [80.253, 12.95], [80.253, 12.921],
      [80.211, 12.916], [80.191, 12.937], [80.207, 12.961],
    ],
    { id: "ward-190", kind: "ward", name: "Pallikaranai", description: "Ward 190", class: "ward-b" },
  ),
  polygon(
    [
      [80.228, 12.966], [80.253, 12.997], [80.284, 12.978], [80.289, 12.944],
      [80.253, 12.921], [80.253, 12.95], [80.228, 12.966],
    ],
    { id: "ward-186", kind: "ward", name: "Perungudi", description: "Ward 186", class: "ward-a" },
  ),
]);

const water = mixedCollection([
  line(
    [
      [80.174, 13.027], [80.191, 13.025], [80.207, 13.023], [80.222, 13.026],
      [80.239, 13.022], [80.254, 13.026], [80.27, 13.022], [80.291, 13.019],
    ],
    { id: "adyar-river", kind: "place", name: "Adyar River", description: "Primary river corridor", class: "river" },
  ),
  polygon(
    [
      [80.208, 12.951], [80.225, 12.958], [80.247, 12.951], [80.263, 12.93],
      [80.256, 12.91], [80.228, 12.905], [80.204, 12.919], [80.197, 12.938],
      [80.208, 12.951],
    ],
    { id: "pallikaranai-marsh", kind: "place", name: "Pallikaranai Marsh", description: "Wetland and natural drainage basin", class: "marsh" },
  ),
]);

const roads = JSON.parse(osmBaselineSource) as MapFeatureCollection<LineGeometry>;

const currentFlood = collection([
  polygon(
    [[80.199, 12.998], [80.211, 13.002], [80.226, 12.997], [80.231, 12.986], [80.226, 12.973], [80.213, 12.969], [80.201, 12.978], [80.195, 12.989], [80.199, 12.998]],
    { id: "flood-velachery-now", kind: "flood", name: "Velachery rapid impact estimate", description: "Modelled current flooding, p50", status: "current", confidence: 0.88 },
  ),
  polygon(
    [[80.219, 13.029], [80.236, 13.03], [80.248, 13.025], [80.242, 13.017], [80.228, 13.014], [80.216, 13.021], [80.219, 13.029]],
    { id: "flood-saidapet-now", kind: "flood", name: "Saidapet river-edge estimate", description: "Observed and modelled flooding", status: "current", confidence: 0.82 },
  ),
  polygon(
    [[80.212, 12.957], [80.228, 12.961], [80.246, 12.954], [80.252, 12.939], [80.241, 12.926], [80.22, 12.923], [80.207, 12.937], [80.212, 12.957]],
    { id: "flood-pallikaranai-now", kind: "flood", name: "Pallikaranai basin estimate", description: "Wetland and low-lying street flooding", status: "current", confidence: 0.9 },
  ),
  polygon(
    [[80.249, 13.018], [80.267, 13.022], [80.279, 13.016], [80.274, 13.006], [80.258, 13.003], [80.247, 13.01], [80.249, 13.018]],
    { id: "flood-adyar-now", kind: "flood", name: "Adyar flood estimate", description: "Modelled current flooding", status: "current", confidence: 0.78 },
  ),
]);

const predictedFlood1h = collection([
  polygon(
    [[80.193, 13.003], [80.21, 13.009], [80.229, 13.002], [80.239, 12.987], [80.232, 12.966], [80.214, 12.959], [80.196, 12.969], [80.187, 12.987], [80.193, 13.003]],
    { id: "flood-velachery-1h", kind: "flood", name: "Velachery +1h rapid impact estimate", description: "Predicted extent; not a certified flood depth", status: "predicted-1h", confidence: 0.79 },
  ),
  polygon(
    [[80.211, 13.035], [80.235, 13.038], [80.258, 13.03], [80.254, 13.014], [80.232, 13.008], [80.211, 13.018], [80.211, 13.035]],
    { id: "flood-saidapet-1h", kind: "flood", name: "Saidapet +1h estimate", description: "Predicted river-edge extent", status: "predicted-1h", confidence: 0.74 },
  ),
  polygon(
    [[80.203, 12.964], [80.229, 12.968], [80.255, 12.957], [80.263, 12.937], [80.249, 12.917], [80.218, 12.912], [80.197, 12.932], [80.203, 12.964]],
    { id: "flood-pallikaranai-1h", kind: "flood", name: "Pallikaranai +1h estimate", description: "Predicted basin extent", status: "predicted-1h", confidence: 0.84 },
  ),
]);

const predictedFlood3h = collection([
  polygon(
    [[80.183, 13.01], [80.207, 13.016], [80.235, 13.007], [80.248, 12.988], [80.238, 12.958], [80.213, 12.949], [80.189, 12.961], [80.178, 12.986], [80.183, 13.01]],
    { id: "flood-velachery-3h", kind: "flood", name: "Velachery +3h rapid impact estimate", description: "Predicted extent; not a certified flood depth", status: "predicted-3h", confidence: 0.67 },
  ),
  polygon(
    [[80.199, 13.04], [80.235, 13.044], [80.272, 13.035], [80.275, 13.015], [80.248, 13.002], [80.215, 13.006], [80.196, 13.021], [80.199, 13.04]],
    { id: "flood-saidapet-3h", kind: "flood", name: "Saidapet and Adyar +3h estimate", description: "Predicted river corridor extent", status: "predicted-3h", confidence: 0.65 },
  ),
  polygon(
    [[80.191, 12.973], [80.229, 12.977], [80.268, 12.962], [80.278, 12.934], [80.257, 12.905], [80.213, 12.9], [80.185, 12.928], [80.191, 12.973]],
    { id: "flood-pallikaranai-3h", kind: "flood", name: "Pallikaranai +3h estimate", description: "Predicted basin extent", status: "predicted-3h", confidence: 0.73 },
  ),
]);

const closures = collection([
  line([[80.202, 12.989], [80.211, 12.989], [80.22, 12.987]], { id: "closure-velachery-main", kind: "closure", name: "Velachery Main Road", description: "Community-corroborated impassable segment; not an official closure", status: "community-corroborated" }),
  line([[80.216, 13.005], [80.217, 12.994], [80.218, 12.984]], { id: "closure-100-feet", kind: "closure", name: "100 Feet Road", description: "Road at risk in rapid impact estimate", status: "at-risk" }),
  line([[80.229, 13.018], [80.234, 13.015], [80.24, 13.013]], { id: "closure-saidapet-bridge", kind: "closure", name: "Saidapet bridge approach", description: "Authorized closure in demo incident", status: "authorized" }),
]);

const lowerRiskRoutes = collection([
  line(
    [[80.202, 12.989], [80.199, 12.98], [80.205, 12.971], [80.214, 12.964], [80.218, 12.951], [80.224, 12.941]],
    { id: "route-pallikaranai", kind: "route", name: "Lower-risk route to Pallikaranai Community Hall", description: "Avoids three at-risk road segments; conditions may change", status: "recommended", class: "recommended" },
  ),
  line(
    [[80.202, 12.989], [80.193, 12.998], [80.194, 13.009], [80.205, 13.018]],
    { id: "route-kalignar", kind: "route", name: "Alternative route to Kalaignar Arangam", description: "Longer route with uncertain surface water", status: "alternate", class: "alternate" },
  ),
]);

const shelters = collection([
  point([80.203, 12.984], { id: "shelter-velachery", kind: "shelter", name: "Velachery School Shelter", description: "Open · 128 spaces reported", status: "open", class: "school" }),
  point([80.224, 12.941], { id: "shelter-pallikaranai", kind: "shelter", name: "Pallikaranai Community Hall", description: "Open · lower-risk route available", status: "open", class: "community" }),
  point([80.205, 13.018], { id: "shelter-kalignar", kind: "shelter", name: "Kalaignar Arangam Shelter", description: "Open · capacity unconfirmed", status: "unknown-capacity", class: "community" }),
  point([80.247, 13.025], { id: "shelter-kendriya", kind: "shelter", name: "Kendriya Vidyalaya Shelter", description: "Open · 74 spaces reported", status: "open", class: "school" }),
  point([80.269, 13.012], { id: "shelter-church-park", kind: "shelter", name: "Church Park Shelter", description: "Access under review", status: "review", class: "community" }),
]);

const hospitals = collection([
  point([80.19, 13.011], { id: "hospital-prashanth", kind: "hospital", name: "Prashanth Hospital", description: "Critical asset · access currently open", status: "open" }),
  point([80.226, 13.035], { id: "hospital-saidapet", kind: "hospital", name: "Saidapet Government Hospital", description: "Critical asset · north approach open", status: "open" }),
  point([80.267, 13.026], { id: "hospital-rainbow", kind: "hospital", name: "Rainbow Children's Hospital", description: "Critical asset · access at risk", status: "at-risk" }),
]);

const reports = collection([
  point([80.2168, 12.9829], { id: "report-1", kind: "report", name: "Report R-9A3F", description: "0.70 m estimate · submerged road · 8 min ago", confidence: 0.93, status: "eligible", count: 1 }),
  point([80.2197, 12.9798], { id: "report-2", kind: "report", name: "Report R-B17C", description: "0.80 m estimate · submerged road · 7 min ago", confidence: 0.95, status: "eligible", count: 2 }),
  point([80.2234, 12.9841], { id: "report-3", kind: "report", name: "Report R-4D8E", description: "0.60 m estimate · high water · 6 min ago", confidence: 0.87, status: "eligible", count: 3 }),
  point([80.2214, 12.9767], { id: "report-4", kind: "report", name: "Report R-3F91", description: "0.75 m estimate · submerged road · 4 min ago", confidence: 0.91, status: "eligible", count: 4 }),
  point([80.2175, 12.9747], { id: "report-5", kind: "report", name: "Responder report R-6C22", description: "0.90 m estimate · submerged road · 3 min ago", confidence: 0.98, status: "eligible", count: 5 }),
  point([80.2145, 12.9782], { id: "report-6", kind: "report", name: "Report R-2A7D", description: "0.65 m estimate · high water · 2 min ago", confidence: 0.9, status: "eligible", count: 6 }),
  point([80.2121, 12.9811], { id: "report-duplicate", kind: "report", name: "Duplicate report R-7E55", description: "Excluded: near-identical evidence family", confidence: 0.32, status: "duplicate", class: "duplicate" }),
  point([80.2327, 12.9846], { id: "report-conflict", kind: "report", name: "Possible conflict R-1D4B", description: "Shallower water estimate · review required", confidence: 0.41, status: "conflict", class: "conflict" }),
]);

const clusters = mixedCollection([
  polygon(
    [[80.209, 12.988], [80.212, 12.991], [80.218, 12.993], [80.224, 12.991], [80.229, 12.986], [80.23, 12.98], [80.227, 12.974], [80.221, 12.97], [80.214, 12.971], [80.209, 12.976], [80.207, 12.982], [80.209, 12.988]],
    { id: "cluster-velachery-boundary", kind: "cluster", name: "Velachery Cluster boundary", description: "250 m corroboration boundary", confidence: 0.92, count: 6, status: "community-corroborated", class: "boundary" },
  ),
  point([80.2189, 12.9814], { id: "cluster-velachery", kind: "cluster", name: "VEL-042 · Velachery", description: "Corroborated by 6 independent recent reports; not an official confirmation", confidence: 0.92, count: 6, status: "community-corroborated", class: "centroid" }),
  point([80.211, 13.021], { id: "cluster-saidapet", kind: "cluster", name: "SAI-018 · Saidapet", description: "5 independent recent reports · needs review", confidence: 0.88, count: 5, status: "needs-review", class: "centroid" }),
  point([80.233, 12.947], { id: "cluster-pallikaranai", kind: "cluster", name: "PAL-031 · Pallikaranai", description: "7 independent recent reports · needs review", confidence: 0.85, count: 7, status: "needs-review", class: "centroid" }),
]);

const resilienceHotspots = collection([
  point([80.221, 12.948], { id: "hotspot-1", kind: "hotspot", name: "Pallikaranai drain corridor", description: "9 verified events · 18,600 people exposed", confidence: 0.91, rank: 1, count: 9, status: "high" }),
  point([80.202, 12.989], { id: "hotspot-2", kind: "hotspot", name: "Velachery Main Road underpass", description: "7 verified events · frequent road closure", confidence: 0.86, rank: 2, count: 7, status: "high" }),
  point([80.229, 13.018], { id: "hotspot-3", kind: "hotspot", name: "Saidapet bridge approach", description: "6 verified events · hospital access affected", confidence: 0.79, rank: 3, count: 6, status: "medium" }),
  point([80.248, 12.973], { id: "hotspot-4", kind: "hotspot", name: "Perungudi culvert", description: "5 verified events · frequent road closure", confidence: 0.74, rank: 4, count: 5, status: "medium" }),
  point([80.205, 13.018], { id: "hotspot-5", kind: "hotspot", name: "Ward 174 shelter access", description: "4 verified events · access delayed", confidence: 0.68, rank: 5, count: 4, status: "medium" }),
  point([80.242, 12.958], { id: "hotspot-6", kind: "hotspot", name: "Taramani Link Road", description: "4 verified events · recurring isolation", confidence: 0.66, rank: 6, count: 4, status: "medium" }),
]);

const resilienceZones = collection([
  polygon([[80.205, 12.963], [80.222, 12.966], [80.235, 12.956], [80.231, 12.941], [80.215, 12.935], [80.201, 12.947], [80.205, 12.963]], { id: "recurrence-pallikaranai", kind: "hotspot", name: "Pallikaranai recurrent flooding", description: "More than 20 observed or verified events", count: 22, status: "very-high", color: "#4537c8" }),
  polygon([[80.192, 12.999], [80.211, 13.003], [80.224, 12.992], [80.219, 12.978], [80.202, 12.974], [80.19, 12.984], [80.192, 12.999]], { id: "recurrence-velachery", kind: "hotspot", name: "Velachery recurrent flooding", description: "10–20 observed or verified events", count: 17, status: "high", color: "#6155d9" }),
  polygon([[80.213, 13.031], [80.233, 13.034], [80.246, 13.023], [80.235, 13.011], [80.218, 13.014], [80.213, 13.031]], { id: "recurrence-saidapet", kind: "hotspot", name: "Saidapet recurrent flooding", description: "10–20 observed or verified events", count: 14, status: "high", color: "#6155d9" }),
  polygon([[80.237, 12.985], [80.255, 12.987], [80.266, 12.975], [80.257, 12.961], [80.24, 12.964], [80.237, 12.985]], { id: "recurrence-perungudi", kind: "hotspot", name: "Perungudi recurrent flooding", description: "5–10 observed or verified events", count: 8, status: "medium", color: "#8b82e8" }),
  polygon([[80.243, 13.025], [80.265, 13.029], [80.277, 13.017], [80.265, 13.006], [80.248, 13.01], [80.243, 13.025]], { id: "recurrence-adyar", kind: "hotspot", name: "Adyar recurrent flooding", description: "5–10 observed or verified events", count: 7, status: "medium", color: "#8b82e8" }),
]);

const resilienceIssues = collection([
  line([[80.211, 12.964], [80.218, 12.956], [80.224, 12.944], [80.23, 12.934]], { id: "issue-drain-pallikaranai", kind: "resilience_issue", name: "Pallikaranai drainage bottleneck", description: "Prioritise site inspection and hydraulic assessment", status: "inspect", class: "drainage" }),
  line([[80.202, 12.989], [80.211, 12.989], [80.22, 12.987]], { id: "issue-road-velachery", kind: "resilience_issue", name: "Velachery recurring road isolation", description: "Road repeatedly closed in verified events", status: "assess", class: "road" }),
  line([[80.205, 13.018], [80.213, 13.011], [80.22, 13.006]], { id: "issue-shelter-saidapet", kind: "resilience_issue", name: "Saidapet shelter access gap", description: "Average access delay +18 minutes", status: "evaluate", class: "shelter" }),
  line([[80.238, 12.958], [80.247, 12.963], [80.254, 12.973]], { id: "issue-shelter-perungudi", kind: "resilience_issue", name: "Perungudi shelter access gap", description: "Evaluate alternative shelter access", status: "evaluate", class: "shelter" }),
]);

const places = collection([
  point([80.207, 12.99], { id: "place-velachery", kind: "place", name: "VELACHERY", class: "district" }),
  point([80.211, 13.026], { id: "place-saidapet", kind: "place", name: "SAIDAPET", class: "district" }),
  point([80.256, 13.03], { id: "place-adyar", kind: "place", name: "ADYAR", class: "district" }),
  point([80.225, 12.925], { id: "place-pallikaranai", kind: "place", name: "PALLIKARANAI", class: "district" }),
  point([80.193, 13.02], { id: "place-guindy", kind: "place", name: "GUINDY", class: "district" }),
  point([80.245, 13.027], { id: "place-adyar-river", kind: "place", name: "Adyar River", class: "water-label" }),
  point([80.238, 12.918], { id: "place-marsh", kind: "place", name: "Pallikaranai Marsh", class: "water-label" }),
]);

export const chennaiMapData: ChennaiMapData = {
  wards,
  water,
  roads,
  currentFlood,
  predictedFlood1h,
  predictedFlood3h,
  closures,
  lowerRiskRoutes,
  shelters,
  hospitals,
  reports,
  clusters,
  resilienceHotspots,
  resilienceZones,
  resilienceIssues,
  places,
};
