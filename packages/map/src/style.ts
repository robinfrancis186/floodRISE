import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

import { keralaMapData } from "./data/kerala";
import type {
  FloodMapVariant,
  MapHorizon,
  MapPosition,
  ResilienceLayerVisibility,
} from "./types";

const visibility = (shown: boolean): "visible" | "none" => (shown ? "visible" : "none");

const isOperationalVariant = (variant: FloodMapVariant) => variant !== "resilience";

const osmTileUrl = (
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_OSM_TILE_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
).trim();

export const initialViews: Record<
  FloodMapVariant,
  { center: MapPosition; zoom: number; minZoom: number; maxZoom: number }
> = {
  operations: { center: [76.356, 10.107], zoom: 12.35, minZoom: 7, maxZoom: 19 },
  signals: { center: [76.35, 10.106], zoom: 14, minZoom: 9, maxZoom: 19 },
  resilience: { center: [76.357, 10.103], zoom: 12.35, minZoom: 7, maxZoom: 19 },
  field: { center: [76.349, 10.108], zoom: 13.8, minZoom: 9, maxZoom: 19 },
};

export const interactiveLayerIds = [
  "ward-fill",
  "current-flood-fill",
  "predicted-flood-1h-fill",
  "predicted-flood-3h-fill",
  "closure-line-hit",
  "lower-risk-route-hit",
  "resilience-zone-fill",
  "resilience-drainage-hit",
  "resilience-road-hit",
  "resilience-shelter-hit",
] as const;

export function createMapStyle(
  variant: FloodMapVariant,
  horizon: MapHorizon,
  resilienceLayers?: ResilienceLayerVisibility,
  showRouteGeometry = variant === "operations",
): StyleSpecification {
  const operational = isOperationalVariant(variant);
  const showRoutes = variant === "operations" && showRouteGeometry;
  const showClosures = variant === "operations" || variant === "field";
  const showSignalBoundary = variant === "signals";
  const showResilience = variant === "resilience";
  const showRecurringFlooding = showResilience && (resilienceLayers?.recurringFlooding ?? true);
  const showDrainageIssues = showResilience && (resilienceLayers?.drainageIssues ?? true);
  const showRoadIsolation = showResilience && (resilienceLayers?.roadIsolation ?? true);
  const showShelterGaps = showResilience && (resilienceLayers?.shelterGaps ?? true);

  return {
    version: 8,
    name: "floodRISE Kerala detailed OpenStreetMap with offline response overlays",
    sources: {
      "osm-detail": {
        type: "raster",
        tiles: [osmTileUrl],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 19,
        attribution: "© OpenStreetMap contributors",
      },
      wards: { type: "geojson", data: keralaMapData.wards },
      water: { type: "geojson", data: keralaMapData.water },
      roads: { type: "geojson", data: keralaMapData.roads },
      "current-flood": { type: "geojson", data: keralaMapData.currentFlood },
      "predicted-flood-1h": { type: "geojson", data: keralaMapData.predictedFlood1h },
      "predicted-flood-3h": { type: "geojson", data: keralaMapData.predictedFlood3h },
      closures: { type: "geojson", data: keralaMapData.closures },
      routes: { type: "geojson", data: keralaMapData.lowerRiskRoutes },
      clusters: { type: "geojson", data: keralaMapData.clusters },
      "resilience-zones": { type: "geojson", data: keralaMapData.resilienceZones },
      "resilience-issues": { type: "geojson", data: keralaMapData.resilienceIssues },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#f8fafc" },
      },
      {
        id: "osm-detail",
        type: "raster",
        source: "osm-detail",
        paint: {
          "raster-opacity": 0.96,
          "raster-saturation": -0.22,
          "raster-contrast": -0.06,
        },
      },
      {
        id: "ward-fill",
        type: "fill",
        source: "wards",
        paint: {
          "fill-color": ["match", ["get", "class"], "ward-a", "#f4f7fa", "#eef2f6"],
          "fill-opacity": 0.2,
        },
      },
      {
        id: "ward-line",
        type: "line",
        source: "wards",
        paint: {
          "line-color": "#9aa8b9",
          "line-width": 1.2,
          "line-dasharray": [3, 2],
          "line-opacity": 0.82,
        },
      },
      {
        id: "marsh-fill",
        type: "fill",
        source: "water",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#d9efe8", "fill-opacity": 0.48 },
      },
      {
        id: "river-casing",
        type: "line",
        source: "water",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#d5efff", "line-width": 13, "line-opacity": 0.95 },
      },
      {
        id: "river-line",
        type: "line",
        source: "water",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#72c6f3", "line-width": 8, "line-opacity": 0.9 },
      },
      {
        id: "predicted-flood-3h-fill",
        type: "fill",
        source: "predicted-flood-3h",
        layout: { visibility: visibility(operational && horizon === "3h") },
        paint: { "fill-color": "#75baf8", "fill-opacity": 0.24 },
      },
      {
        id: "predicted-flood-3h-outline",
        type: "line",
        source: "predicted-flood-3h",
        layout: { visibility: visibility(operational && horizon === "3h") },
        paint: {
          "line-color": "#438fe5",
          "line-width": 1.5,
          "line-dasharray": [2, 2],
          "line-opacity": 0.9,
        },
      },
      {
        id: "predicted-flood-1h-fill",
        type: "fill",
        source: "predicted-flood-1h",
        layout: { visibility: visibility(operational && horizon === "1h") },
        paint: { "fill-color": "#72bff9", "fill-opacity": 0.28 },
      },
      {
        id: "predicted-flood-1h-outline",
        type: "line",
        source: "predicted-flood-1h",
        layout: { visibility: visibility(operational && horizon === "1h") },
        paint: {
          "line-color": "#357fd8",
          "line-width": 1.5,
          "line-dasharray": [2, 2],
          "line-opacity": 0.9,
        },
      },
      {
        id: "current-flood-fill",
        type: "fill",
        source: "current-flood",
        layout: { visibility: visibility(operational) },
        paint: { "fill-color": "#79c5fb", "fill-opacity": 0.55 },
      },
      {
        id: "current-flood-outline",
        type: "line",
        source: "current-flood",
        layout: { visibility: visibility(operational) },
        paint: { "line-color": "#3c9fe8", "line-width": 1.2, "line-opacity": 0.72 },
      },
      {
        id: "resilience-zone-fill",
        type: "fill",
        source: "resilience-zones",
        layout: { visibility: visibility(showRecurringFlooding) },
        paint: {
          "fill-color": ["coalesce", ["get", "color"], "#6155d9"],
          "fill-opacity": ["interpolate", ["linear"], ["get", "count"], 5, 0.24, 22, 0.56],
        },
      },
      {
        id: "resilience-zone-outline",
        type: "line",
        source: "resilience-zones",
        layout: { visibility: visibility(showRecurringFlooding) },
        paint: { "line-color": "#5448c8", "line-width": 1.2, "line-opacity": 0.72 },
      },
      {
        id: "road-casing",
        type: "line",
        source: "roads",
        paint: {
          "line-color": "#ffffff",
          "line-width": ["match", ["get", "class"], "trunk", 7, "primary", 6, "secondary", 4.5, 3.5],
          "line-opacity": 0.98,
        },
      },
      {
        id: "road-line",
        type: "line",
        source: "roads",
        paint: {
          "line-color": ["match", ["get", "class"], "trunk", "#f1a66a", "primary", "#c8d0db", "#d5dce5"],
          "line-width": ["match", ["get", "class"], "trunk", 3, "primary", 2, "secondary", 1.5, 1],
          "line-opacity": 0.95,
        },
      },
      {
        id: "cluster-boundary-fill",
        type: "fill",
        source: "clusters",
        filter: ["all", ["==", ["geometry-type"], "Polygon"], ["==", ["get", "class"], "boundary"]],
        layout: { visibility: visibility(showSignalBoundary) },
        paint: { "fill-color": "#1468e8", "fill-opacity": 0.055 },
      },
      {
        id: "cluster-boundary",
        type: "line",
        source: "clusters",
        filter: ["all", ["==", ["geometry-type"], "Polygon"], ["==", ["get", "class"], "boundary"]],
        layout: { visibility: visibility(showSignalBoundary) },
        paint: { "line-color": "#1468e8", "line-width": 2, "line-dasharray": [3, 2], "line-opacity": 0.9 },
      },
      {
        id: "lower-risk-route-casing",
        type: "line",
        source: "routes",
        layout: { visibility: visibility(showRoutes) },
        paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.95 },
      },
      {
        id: "lower-risk-route-line",
        type: "line",
        source: "routes",
        layout: { visibility: visibility(showRoutes) },
        paint: {
          "line-color": ["match", ["get", "class"], "recommended", "#f2ca00", "#062d78"],
          "line-width": ["match", ["get", "class"], "recommended", 4, 3],
        },
      },
      {
        id: "lower-risk-route-hit",
        type: "line",
        source: "routes",
        layout: { visibility: visibility(showRoutes) },
        paint: { "line-color": "#000000", "line-width": 16, "line-opacity": 0 },
      },
      {
        id: "closure-casing",
        type: "line",
        source: "closures",
        layout: { visibility: visibility(showClosures) },
        paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.96 },
      },
      {
        id: "closure-line",
        type: "line",
        source: "closures",
        layout: { visibility: visibility(showClosures) },
        paint: { "line-color": "#e3242b", "line-width": 3.5, "line-opacity": 1 },
      },
      {
        id: "closure-line-hit",
        type: "line",
        source: "closures",
        layout: { visibility: visibility(showClosures) },
        paint: { "line-color": "#000000", "line-width": 16, "line-opacity": 0 },
      },
      {
        id: "resilience-drainage",
        type: "line",
        source: "resilience-issues",
        filter: ["==", ["get", "class"], "drainage"],
        layout: { visibility: visibility(showDrainageIssues) },
        paint: { "line-color": "#f0b400", "line-width": 4, "line-dasharray": [2, 1.5] },
      },
      {
        id: "resilience-drainage-hit",
        type: "line",
        source: "resilience-issues",
        filter: ["==", ["get", "class"], "drainage"],
        layout: { visibility: visibility(showDrainageIssues) },
        paint: { "line-color": "#000000", "line-width": 16, "line-opacity": 0 },
      },
      {
        id: "resilience-road",
        type: "line",
        source: "resilience-issues",
        filter: ["==", ["get", "class"], "road"],
        layout: { visibility: visibility(showRoadIsolation) },
        paint: { "line-color": "#e3242b", "line-width": 4, "line-dasharray": [1.5, 1.2] },
      },
      {
        id: "resilience-road-hit",
        type: "line",
        source: "resilience-issues",
        filter: ["==", ["get", "class"], "road"],
        layout: { visibility: visibility(showRoadIsolation) },
        paint: { "line-color": "#000000", "line-width": 16, "line-opacity": 0 },
      },
      {
        id: "resilience-shelter",
        type: "line",
        source: "resilience-issues",
        filter: ["==", ["get", "class"], "shelter"],
        layout: { visibility: visibility(showShelterGaps) },
        paint: { "line-color": "#7b2cbf", "line-width": 4, "line-dasharray": [2, 1.5] },
      },
      {
        id: "resilience-shelter-hit",
        type: "line",
        source: "resilience-issues",
        filter: ["==", ["get", "class"], "shelter"],
        layout: { visibility: visibility(showShelterGaps) },
        paint: { "line-color": "#000000", "line-width": 16, "line-opacity": 0 },
      },
    ],
  } as StyleSpecification;
}

export function updateHorizonLayers(map: MapLibreMap, horizon: MapHorizon): void {
  const horizons: Array<Exclude<MapHorizon, "now">> = ["1h", "3h"];

  for (const value of horizons) {
    const nextVisibility = value === horizon ? "visible" : "none";
    for (const suffix of ["fill", "outline"]) {
      const layerId = `predicted-flood-${value}-${suffix}`;
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", nextVisibility);
      }
    }
  }
}

export function updateResilienceLayers(
  map: MapLibreMap,
  layers: ResilienceLayerVisibility,
): void {
  const groups: Array<[boolean, readonly string[]]> = [
    [layers.recurringFlooding, ["resilience-zone-fill", "resilience-zone-outline"]],
    [layers.drainageIssues, ["resilience-drainage", "resilience-drainage-hit"]],
    [layers.roadIsolation, ["resilience-road", "resilience-road-hit"]],
    [layers.shelterGaps, ["resilience-shelter", "resilience-shelter-hit"]],
  ];

  for (const [shown, layerIds] of groups) {
    for (const layerId of layerIds) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", visibility(shown));
      }
    }
  }
}
