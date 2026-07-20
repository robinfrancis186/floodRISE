import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

import { chennaiMapData } from "./data/chennai";
import type { FloodMapVariant, MapHorizon, MapPosition } from "./types";

const visibility = (shown: boolean): "visible" | "none" => (shown ? "visible" : "none");

const isOperationalVariant = (variant: FloodMapVariant) => variant !== "resilience";

export const initialViews: Record<
  FloodMapVariant,
  { center: MapPosition; zoom: number; minZoom: number; maxZoom: number }
> = {
  operations: { center: [80.225, 12.982], zoom: 12.55, minZoom: 10.5, maxZoom: 17 },
  signals: { center: [80.219, 12.981], zoom: 13.55, minZoom: 11, maxZoom: 18 },
  resilience: { center: [80.226, 12.978], zoom: 12.55, minZoom: 10.5, maxZoom: 17 },
  field: { center: [80.212, 12.985], zoom: 13.35, minZoom: 12, maxZoom: 18 },
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
): StyleSpecification {
  const operational = isOperationalVariant(variant);
  const showRoutes = variant === "operations" || variant === "field";
  const showClosures = variant === "operations" || variant === "field";
  const showSignalBoundary = variant === "signals";
  const showResilience = variant === "resilience";

  return {
    version: 8,
    name: "floodRISE deterministic Chennai offline map",
    sources: {
      wards: { type: "geojson", data: chennaiMapData.wards },
      water: { type: "geojson", data: chennaiMapData.water },
      roads: { type: "geojson", data: chennaiMapData.roads },
      "current-flood": { type: "geojson", data: chennaiMapData.currentFlood },
      "predicted-flood-1h": { type: "geojson", data: chennaiMapData.predictedFlood1h },
      "predicted-flood-3h": { type: "geojson", data: chennaiMapData.predictedFlood3h },
      closures: { type: "geojson", data: chennaiMapData.closures },
      routes: { type: "geojson", data: chennaiMapData.lowerRiskRoutes },
      clusters: { type: "geojson", data: chennaiMapData.clusters },
      "resilience-zones": { type: "geojson", data: chennaiMapData.resilienceZones },
      "resilience-issues": { type: "geojson", data: chennaiMapData.resilienceIssues },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#f8fafc" },
      },
      {
        id: "ward-fill",
        type: "fill",
        source: "wards",
        paint: {
          "fill-color": ["match", ["get", "class"], "ward-a", "#f4f7fa", "#eef2f6"],
          "fill-opacity": 0.9,
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
        paint: { "fill-color": "#d9efe8", "fill-opacity": 0.86 },
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
        layout: { visibility: visibility(showResilience) },
        paint: {
          "fill-color": ["coalesce", ["get", "color"], "#6155d9"],
          "fill-opacity": ["interpolate", ["linear"], ["get", "count"], 5, 0.24, 22, 0.56],
        },
      },
      {
        id: "resilience-zone-outline",
        type: "line",
        source: "resilience-zones",
        layout: { visibility: visibility(showResilience) },
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
        layout: { visibility: visibility(showResilience) },
        paint: { "line-color": "#f0b400", "line-width": 4, "line-dasharray": [2, 1.5] },
      },
      {
        id: "resilience-drainage-hit",
        type: "line",
        source: "resilience-issues",
        filter: ["==", ["get", "class"], "drainage"],
        layout: { visibility: visibility(showResilience) },
        paint: { "line-color": "#000000", "line-width": 16, "line-opacity": 0 },
      },
      {
        id: "resilience-road",
        type: "line",
        source: "resilience-issues",
        filter: ["==", ["get", "class"], "road"],
        layout: { visibility: visibility(showResilience) },
        paint: { "line-color": "#e3242b", "line-width": 4, "line-dasharray": [1.5, 1.2] },
      },
      {
        id: "resilience-road-hit",
        type: "line",
        source: "resilience-issues",
        filter: ["==", ["get", "class"], "road"],
        layout: { visibility: visibility(showResilience) },
        paint: { "line-color": "#000000", "line-width": 16, "line-opacity": 0 },
      },
      {
        id: "resilience-shelter",
        type: "line",
        source: "resilience-issues",
        filter: ["==", ["get", "class"], "shelter"],
        layout: { visibility: visibility(showResilience) },
        paint: { "line-color": "#7b2cbf", "line-width": 4, "line-dasharray": [2, 1.5] },
      },
      {
        id: "resilience-shelter-hit",
        type: "line",
        source: "resilience-issues",
        filter: ["==", ["get", "class"], "shelter"],
        layout: { visibility: visibility(showResilience) },
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
