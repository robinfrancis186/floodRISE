/// <reference path="../geojson.d.ts" />

import type {
  KeralaMapData,
  MapFeature,
  MapFeatureCollection,
  MapFeatureProperties,
  MapPosition,
} from "../types";
import osmBaselineSource from "../../../../fixtures/kerala-demo/osm-map-fallback.geojson?raw";

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
      [76.3280000, 10.1260000], [76.3530000, 10.1290000], [76.3640000, 10.1140000], [76.3590000, 10.0910000],
      [76.3380000, 10.0860000], [76.3220000, 10.1030000], [76.3280000, 10.1260000],
    ],
    { id: "ward-177", kind: "ward", name: "Aluva", description: "Demo response zone A", class: "ward-a" },
  ),
  polygon(
    [
      [76.3260000, 10.1600000], [76.3550000, 10.1630000], [76.3700000, 10.1430000], [76.3530000, 10.1290000],
      [76.3280000, 10.1260000], [76.3190000, 10.1440000], [76.3260000, 10.1600000],
    ],
    { id: "ward-142", kind: "ward", name: "Eloor", description: "Demo response zone B", class: "ward-b" },
  ),
  polygon(
    [
      [76.3550000, 10.1630000], [76.4000000, 10.1640000], [76.4100000, 10.1370000], [76.3840000, 10.1220000],
      [76.3700000, 10.1430000], [76.3550000, 10.1630000],
    ],
    { id: "ward-174", kind: "ward", name: "Kalamassery", description: "Demo response zone 174", class: "ward-a" },
  ),
  polygon(
    [
      [76.3380000, 10.0860000], [76.3590000, 10.0910000], [76.3840000, 10.0750000], [76.3840000, 10.0460000],
      [76.3420000, 10.0410000], [76.3220000, 10.0620000], [76.3380000, 10.0860000],
    ],
    { id: "ward-190", kind: "ward", name: "Kadungalloor", description: "Demo response zone D", class: "ward-b" },
  ),
  polygon(
    [
      [76.3590000, 10.0910000], [76.3840000, 10.1220000], [76.4150000, 10.1030000], [76.4200000, 10.0690000],
      [76.3840000, 10.0460000], [76.3840000, 10.0750000], [76.3590000, 10.0910000],
    ],
    { id: "ward-186", kind: "ward", name: "Edappally", description: "Demo response zone E", class: "ward-a" },
  ),
]);

const water = mixedCollection([
  line(
    [
      [76.3050000, 10.1520000], [76.3220000, 10.1500000], [76.3380000, 10.1480000], [76.3530000, 10.1510000],
      [76.3700000, 10.1470000], [76.3850000, 10.1510000], [76.4010000, 10.1470000], [76.4220000, 10.1440000],
    ],
    { id: "periyar-river", kind: "place", name: "Periyar River", description: "Primary river corridor", class: "river" },
  ),
  polygon(
    [
      [76.3390000, 10.0760000], [76.3560000, 10.0830000], [76.3780000, 10.0760000], [76.3940000, 10.0550000],
      [76.3870000, 10.0350000], [76.3590000, 10.0300000], [76.3350000, 10.0440000], [76.3280000, 10.0630000],
      [76.3390000, 10.0760000],
    ],
    { id: "kadungalloor-marsh", kind: "place", name: "Periyar floodplain", description: "Low-lying floodplain and natural drainage basin", class: "marsh" },
  ),
]);

const roads = JSON.parse(osmBaselineSource) as MapFeatureCollection<LineGeometry>;

const currentFlood = collection([
  polygon(
    [[76.3300000, 10.1230000], [76.3420000, 10.1270000], [76.3570000, 10.1220000], [76.3620000, 10.1110000], [76.3570000, 10.0980000], [76.3440000, 10.0940000], [76.3320000, 10.1030000], [76.3260000, 10.1140000], [76.3300000, 10.1230000]],
    { id: "flood-aluva-now", kind: "flood", name: "Aluva rapid impact estimate", description: "Modelled current flooding, p50", status: "current", confidence: 0.88 },
  ),
  polygon(
    [[76.3500000, 10.1540000], [76.3670000, 10.1550000], [76.3790000, 10.1500000], [76.3730000, 10.1420000], [76.3590000, 10.1390000], [76.3470000, 10.1460000], [76.3500000, 10.1540000]],
    { id: "flood-eloor-now", kind: "flood", name: "Eloor river-edge estimate", description: "Observed and modelled flooding", status: "current", confidence: 0.82 },
  ),
  polygon(
    [[76.3430000, 10.0820000], [76.3590000, 10.0860000], [76.3770000, 10.0790000], [76.3830000, 10.0640000], [76.3720000, 10.0510000], [76.3510000, 10.0480000], [76.3380000, 10.0620000], [76.3430000, 10.0820000]],
    { id: "flood-kadungalloor-now", kind: "flood", name: "Kadungalloor basin estimate", description: "Wetland and low-lying street flooding", status: "current", confidence: 0.9 },
  ),
  polygon(
    [[76.3800000, 10.1430000], [76.3980000, 10.1470000], [76.4100000, 10.1410000], [76.4050000, 10.1310000], [76.3890000, 10.1280000], [76.3780000, 10.1350000], [76.3800000, 10.1430000]],
    { id: "flood-periyar-now", kind: "flood", name: "Periyar flood estimate", description: "Modelled current flooding", status: "current", confidence: 0.78 },
  ),
]);

const predictedFlood1h = collection([
  polygon(
    [[76.3240000, 10.1280000], [76.3410000, 10.1340000], [76.3600000, 10.1270000], [76.3700000, 10.1120000], [76.3630000, 10.0910000], [76.3450000, 10.0840000], [76.3270000, 10.0940000], [76.3180000, 10.1120000], [76.3240000, 10.1280000]],
    { id: "flood-aluva-1h", kind: "flood", name: "Aluva +1h rapid impact estimate", description: "Predicted extent; not a certified flood depth", status: "predicted-1h", confidence: 0.79 },
  ),
  polygon(
    [[76.3420000, 10.1600000], [76.3660000, 10.1630000], [76.3890000, 10.1550000], [76.3850000, 10.1390000], [76.3630000, 10.1330000], [76.3420000, 10.1430000], [76.3420000, 10.1600000]],
    { id: "flood-eloor-1h", kind: "flood", name: "Eloor +1h estimate", description: "Predicted river-edge extent", status: "predicted-1h", confidence: 0.74 },
  ),
  polygon(
    [[76.3340000, 10.0890000], [76.3600000, 10.0930000], [76.3860000, 10.0820000], [76.3940000, 10.0620000], [76.3800000, 10.0420000], [76.3490000, 10.0370000], [76.3280000, 10.0570000], [76.3340000, 10.0890000]],
    { id: "flood-kadungalloor-1h", kind: "flood", name: "Kadungalloor +1h estimate", description: "Predicted basin extent", status: "predicted-1h", confidence: 0.84 },
  ),
]);

const predictedFlood3h = collection([
  polygon(
    [[76.3140000, 10.1350000], [76.3380000, 10.1410000], [76.3660000, 10.1320000], [76.3790000, 10.1130000], [76.3690000, 10.0830000], [76.3440000, 10.0740000], [76.3200000, 10.0860000], [76.3090000, 10.1110000], [76.3140000, 10.1350000]],
    { id: "flood-aluva-3h", kind: "flood", name: "Aluva +3h rapid impact estimate", description: "Predicted extent; not a certified flood depth", status: "predicted-3h", confidence: 0.67 },
  ),
  polygon(
    [[76.3300000, 10.1650000], [76.3660000, 10.1690000], [76.4030000, 10.1600000], [76.4060000, 10.1400000], [76.3790000, 10.1270000], [76.3460000, 10.1310000], [76.3270000, 10.1460000], [76.3300000, 10.1650000]],
    { id: "flood-eloor-3h", kind: "flood", name: "Eloor and Periyar +3h estimate", description: "Predicted river corridor extent", status: "predicted-3h", confidence: 0.65 },
  ),
  polygon(
    [[76.3220000, 10.0980000], [76.3600000, 10.1020000], [76.3990000, 10.0870000], [76.4090000, 10.0590000], [76.3880000, 10.0300000], [76.3440000, 10.0250000], [76.3160000, 10.0530000], [76.3220000, 10.0980000]],
    { id: "flood-kadungalloor-3h", kind: "flood", name: "Kadungalloor +3h estimate", description: "Predicted basin extent", status: "predicted-3h", confidence: 0.73 },
  ),
]);

const closures = collection([
  line([[76.3330000, 10.1140000], [76.3420000, 10.1140000], [76.3510000, 10.1120000]], { id: "closure-aluva-main", kind: "closure", name: "Aluva–Paravur Road", description: "Community-corroborated impassable segment; not an official closure", status: "community-corroborated" }),
  line([[76.3470000, 10.1300000], [76.3480000, 10.1190000], [76.3490000, 10.1090000]], { id: "closure-nh-544", kind: "closure", name: "NH 544 approach", description: "Road at risk in rapid impact estimate", status: "at-risk" }),
  line([[76.3600000, 10.1430000], [76.3650000, 10.1400000], [76.3710000, 10.1380000]], { id: "closure-eloor-bridge", kind: "closure", name: "Eloor bridge approach", description: "Authorized closure in demo incident", status: "authorized" }),
]);

const lowerRiskRoutes = collection([
  line(
    [[76.3330000, 10.1140000], [76.3300000, 10.1050000], [76.3360000, 10.0960000], [76.3450000, 10.0890000], [76.3490000, 10.0760000], [76.3550000, 10.0660000]],
    { id: "route-kadungalloor", kind: "route", name: "Lower-risk route to Kadungalloor Community Hall", description: "Avoids three at-risk road segments; conditions may change", status: "recommended", class: "recommended" },
  ),
  line(
    [[76.3330000, 10.1140000], [76.3240000, 10.1230000], [76.3250000, 10.1340000], [76.3360000, 10.1430000]],
    { id: "route-kalamassery", kind: "route", name: "Alternative route to Kalamassery Community Shelter", description: "Longer route with uncertain surface water", status: "alternate", class: "alternate" },
  ),
]);

const shelters = collection([
  point([76.3340000, 10.1090000], { id: "shelter-aluva", kind: "shelter", name: "Aluva School Shelter", description: "Open · 128 spaces reported", status: "open", class: "school" }),
  point([76.3550000, 10.0660000], { id: "shelter-kadungalloor", kind: "shelter", name: "Kadungalloor Community Hall", description: "Open · lower-risk route available", status: "open", class: "community" }),
  point([76.3360000, 10.1430000], { id: "shelter-kalamassery", kind: "shelter", name: "Kalamassery Community Shelter", description: "Open · capacity unconfirmed", status: "unknown-capacity", class: "community" }),
  point([76.3780000, 10.1500000], { id: "shelter-kendriya", kind: "shelter", name: "Kendriya Vidyalaya Shelter", description: "Open · 74 spaces reported", status: "open", class: "school" }),
  point([76.4000000, 10.1370000], { id: "shelter-eloor-community", kind: "shelter", name: "Eloor Community Shelter", description: "Access under review", status: "review", class: "community" }),
]);

const hospitals = collection([
  point([76.3210000, 10.1360000], { id: "hospital-aluva", kind: "hospital", name: "Aluva hospital asset", description: "Demo critical asset · access currently open", status: "open" }),
  point([76.3570000, 10.1600000], { id: "hospital-eloor", kind: "hospital", name: "Eloor hospital asset", description: "Demo critical asset · north approach open", status: "open" }),
  point([76.3980000, 10.1510000], { id: "hospital-kalamassery", kind: "hospital", name: "Kalamassery hospital asset", description: "Demo critical asset · access at risk", status: "at-risk" }),
]);

const reports = collection([
  point([76.3478000, 10.1079000], { id: "report-1", kind: "report", name: "Report R-9A3F", description: "0.70 m estimate · submerged road · 8 min ago", confidence: 0.93, status: "eligible", count: 1 }),
  point([76.3507000, 10.1048000], { id: "report-2", kind: "report", name: "Report R-B17C", description: "0.80 m estimate · submerged road · 7 min ago", confidence: 0.95, status: "eligible", count: 2 }),
  point([76.3544000, 10.1091000], { id: "report-3", kind: "report", name: "Report R-4D8E", description: "0.60 m estimate · high water · 6 min ago", confidence: 0.87, status: "eligible", count: 3 }),
  point([76.3524000, 10.1017000], { id: "report-4", kind: "report", name: "Report R-3F91", description: "0.75 m estimate · submerged road · 4 min ago", confidence: 0.91, status: "eligible", count: 4 }),
  point([76.3485000, 10.0997000], { id: "report-5", kind: "report", name: "Responder report R-6C22", description: "0.90 m estimate · submerged road · 3 min ago", confidence: 0.98, status: "eligible", count: 5 }),
  point([76.3455000, 10.1032000], { id: "report-6", kind: "report", name: "Report R-2A7D", description: "0.65 m estimate · high water · 2 min ago", confidence: 0.9, status: "eligible", count: 6 }),
  point([76.3431000, 10.1061000], { id: "report-duplicate", kind: "report", name: "Duplicate report R-7E55", description: "Excluded: near-identical evidence family", confidence: 0.32, status: "duplicate", class: "duplicate" }),
  point([76.3637000, 10.1096000], { id: "report-conflict", kind: "report", name: "Possible conflict R-1D4B", description: "Shallower water estimate · review required", confidence: 0.41, status: "conflict", class: "conflict" }),
]);

const clusters = mixedCollection([
  polygon(
    [[76.3400000, 10.1130000], [76.3430000, 10.1160000], [76.3490000, 10.1180000], [76.3550000, 10.1160000], [76.3600000, 10.1110000], [76.3610000, 10.1050000], [76.3580000, 10.0990000], [76.3520000, 10.0950000], [76.3450000, 10.0960000], [76.3400000, 10.1010000], [76.3380000, 10.1070000], [76.3400000, 10.1130000]],
    { id: "cluster-aluva-boundary", kind: "cluster", name: "Aluva Cluster boundary", description: "250 m corroboration boundary", confidence: 0.92, count: 6, status: "community-corroborated", class: "boundary" },
  ),
  point([76.3499000, 10.1064000], { id: "cluster-aluva", kind: "cluster", name: "ALV-042 · Aluva", description: "Corroborated by 6 independent recent reports; not an official confirmation", confidence: 0.92, count: 6, status: "community-corroborated", class: "centroid" }),
  point([76.3420000, 10.1460000], { id: "cluster-eloor", kind: "cluster", name: "ELO-018 · Eloor", description: "5 independent recent reports · needs review", confidence: 0.88, count: 5, status: "needs-review", class: "centroid" }),
  point([76.3640000, 10.0720000], { id: "cluster-kadungalloor", kind: "cluster", name: "KDG-031 · Kadungalloor", description: "7 independent recent reports · needs review", confidence: 0.85, count: 7, status: "needs-review", class: "centroid" }),
]);

const resilienceHotspots = collection([
  point([76.3520000, 10.0730000], { id: "hotspot-1", kind: "hotspot", name: "Kadungalloor drain corridor", description: "9 verified events · 18,600 people exposed", confidence: 0.91, rank: 1, count: 9, status: "high" }),
  point([76.3330000, 10.1140000], { id: "hotspot-2", kind: "hotspot", name: "Aluva–Paravur Road low point", description: "7 verified events · frequent road closure", confidence: 0.86, rank: 2, count: 7, status: "high" }),
  point([76.3600000, 10.1430000], { id: "hotspot-3", kind: "hotspot", name: "Eloor bridge approach", description: "6 verified events · hospital access affected", confidence: 0.79, rank: 3, count: 6, status: "medium" }),
  point([76.3790000, 10.0980000], { id: "hotspot-4", kind: "hotspot", name: "Edappally culvert", description: "5 verified events · frequent road closure", confidence: 0.74, rank: 4, count: 5, status: "medium" }),
  point([76.3360000, 10.1430000], { id: "hotspot-5", kind: "hotspot", name: "Kalamassery shelter access", description: "4 verified events · access delayed", confidence: 0.68, rank: 5, count: 4, status: "medium" }),
  point([76.3730000, 10.0830000], { id: "hotspot-6", kind: "hotspot", name: "HMT Road", description: "4 verified events · recurring isolation", confidence: 0.66, rank: 6, count: 4, status: "medium" }),
]);

const resilienceZones = collection([
  polygon([[76.3360000, 10.0880000], [76.3530000, 10.0910000], [76.3660000, 10.0810000], [76.3620000, 10.0660000], [76.3460000, 10.0600000], [76.3320000, 10.0720000], [76.3360000, 10.0880000]], { id: "recurrence-kadungalloor", kind: "hotspot", name: "Kadungalloor recurrent flooding", description: "More than 20 observed or verified events", count: 22, status: "very-high", color: "#4537c8" }),
  polygon([[76.3230000, 10.1240000], [76.3420000, 10.1280000], [76.3550000, 10.1170000], [76.3500000, 10.1030000], [76.3330000, 10.0990000], [76.3210000, 10.1090000], [76.3230000, 10.1240000]], { id: "recurrence-aluva", kind: "hotspot", name: "Aluva recurrent flooding", description: "10–20 observed or verified events", count: 17, status: "high", color: "#6155d9" }),
  polygon([[76.3440000, 10.1560000], [76.3640000, 10.1590000], [76.3770000, 10.1480000], [76.3660000, 10.1360000], [76.3490000, 10.1390000], [76.3440000, 10.1560000]], { id: "recurrence-eloor", kind: "hotspot", name: "Eloor recurrent flooding", description: "10–20 observed or verified events", count: 14, status: "high", color: "#6155d9" }),
  polygon([[76.3680000, 10.1100000], [76.3860000, 10.1120000], [76.3970000, 10.1000000], [76.3880000, 10.0860000], [76.3710000, 10.0890000], [76.3680000, 10.1100000]], { id: "recurrence-edappally", kind: "hotspot", name: "Edappally recurrent flooding", description: "5–10 observed or verified events", count: 8, status: "medium", color: "#8b82e8" }),
  polygon([[76.3740000, 10.1500000], [76.3960000, 10.1540000], [76.4080000, 10.1420000], [76.3960000, 10.1310000], [76.3790000, 10.1350000], [76.3740000, 10.1500000]], { id: "recurrence-periyar", kind: "hotspot", name: "Periyar recurrent flooding", description: "5–10 observed or verified events", count: 7, status: "medium", color: "#8b82e8" }),
]);

const resilienceIssues = collection([
  line([[76.3420000, 10.0890000], [76.3490000, 10.0810000], [76.3550000, 10.0690000], [76.3610000, 10.0590000]], { id: "issue-drain-kadungalloor", kind: "resilience_issue", name: "Kadungalloor drainage bottleneck", description: "Prioritise site inspection and hydraulic assessment", status: "inspect", class: "drainage" }),
  line([[76.3330000, 10.1140000], [76.3420000, 10.1140000], [76.3510000, 10.1120000]], { id: "issue-road-aluva", kind: "resilience_issue", name: "Aluva recurring road isolation", description: "Road repeatedly closed in verified events", status: "assess", class: "road" }),
  line([[76.3360000, 10.1430000], [76.3440000, 10.1360000], [76.3510000, 10.1310000]], { id: "issue-shelter-eloor", kind: "resilience_issue", name: "Eloor shelter access gap", description: "Average access delay +18 minutes", status: "evaluate", class: "shelter" }),
  line([[76.3690000, 10.0830000], [76.3780000, 10.0880000], [76.3850000, 10.0980000]], { id: "issue-shelter-edappally", kind: "resilience_issue", name: "Edappally shelter access gap", description: "Evaluate alternative shelter access", status: "evaluate", class: "shelter" }),
]);

const places = collection([
  point([76.3380000, 10.1150000], { id: "place-aluva", kind: "place", name: "ALUVA", class: "district" }),
  point([76.3420000, 10.1510000], { id: "place-eloor", kind: "place", name: "ELOOR", class: "district" }),
  point([76.3870000, 10.1550000], { id: "place-kalamassery", kind: "place", name: "KALAMASSERY", class: "district" }),
  point([76.3560000, 10.0500000], { id: "place-kadungalloor", kind: "place", name: "KADUNGALLOOR", class: "district" }),
  point([76.3240000, 10.1450000], { id: "place-ernakulam", kind: "place", name: "ERNAKULAM", class: "district" }),
  point([76.3760000, 10.1520000], { id: "place-periyar-river", kind: "place", name: "Periyar River", class: "water-label" }),
  point([76.3690000, 10.0430000], { id: "place-floodplain", kind: "place", name: "Periyar floodplain", class: "water-label" }),
]);

export const keralaMapData: KeralaMapData = {
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
