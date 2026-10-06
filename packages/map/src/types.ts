import type { CSSProperties } from "react";

export type FloodMapVariant = "operations" | "signals" | "resilience" | "field";

export type MapHorizon = "now" | "1h" | "3h";

export type MapFeatureKind =
  | "ward"
  | "flood"
  | "closure"
  | "route"
  | "shelter"
  | "hospital"
  | "report"
  | "cluster"
  | "hotspot"
  | "resilience_issue"
  | "place";

export type MapPosition = [longitude: number, latitude: number];

export type MapGeometry =
  | { type: "Point"; coordinates: MapPosition }
  | { type: "LineString"; coordinates: MapPosition[] }
  | { type: "Polygon"; coordinates: MapPosition[][] };

export type MapFeatureProperties = {
  id: string;
  kind: MapFeatureKind;
  name: string;
  description?: string;
  confidence?: number;
  status?: string;
  count?: number;
  rank?: number;
  class?: string;
  color?: string;
  [key: string]: string | number | boolean | null | undefined;
};

export type MapFeature<G extends MapGeometry = MapGeometry> = {
  type: "Feature";
  id: string;
  geometry: G;
  properties: MapFeatureProperties;
};

export type MapFeatureCollection<G extends MapGeometry = MapGeometry> = {
  type: "FeatureCollection";
  features: Array<MapFeature<G>>;
};

export type ChennaiMapData = {
  wards: MapFeatureCollection<{ type: "Polygon"; coordinates: MapPosition[][] }>;
  water: MapFeatureCollection;
  roads: MapFeatureCollection<{ type: "LineString"; coordinates: MapPosition[] }>;
  currentFlood: MapFeatureCollection<{ type: "Polygon"; coordinates: MapPosition[][] }>;
  predictedFlood1h: MapFeatureCollection<{ type: "Polygon"; coordinates: MapPosition[][] }>;
  predictedFlood3h: MapFeatureCollection<{ type: "Polygon"; coordinates: MapPosition[][] }>;
  closures: MapFeatureCollection<{ type: "LineString"; coordinates: MapPosition[] }>;
  lowerRiskRoutes: MapFeatureCollection<{ type: "LineString"; coordinates: MapPosition[] }>;
  shelters: MapFeatureCollection<{ type: "Point"; coordinates: MapPosition }>;
  hospitals: MapFeatureCollection<{ type: "Point"; coordinates: MapPosition }>;
  reports: MapFeatureCollection<{ type: "Point"; coordinates: MapPosition }>;
  clusters: MapFeatureCollection;
  resilienceHotspots: MapFeatureCollection<{ type: "Point"; coordinates: MapPosition }>;
  resilienceZones: MapFeatureCollection<{ type: "Polygon"; coordinates: MapPosition[][] }>;
  resilienceIssues: MapFeatureCollection<{ type: "LineString"; coordinates: MapPosition[] }>;
  places: MapFeatureCollection<{ type: "Point"; coordinates: MapPosition }>;
};

export type FloodMapSelection = {
  id: string;
  kind: MapFeatureKind;
  name: string;
  description?: string;
  confidence?: number;
  coordinates?: MapPosition;
  properties: Readonly<MapFeatureProperties>;
};

export type FloodMapProps = {
  variant: FloodMapVariant;
  horizon?: MapHorizon;
  onHorizonChange?: (horizon: MapHorizon) => void;
  selectedFeatureId?: string | null;
  onFeatureSelect?: (selection: FloodMapSelection) => void;
  className?: string;
  height?: CSSProperties["height"];
  showSummary?: boolean;
  showLegend?: boolean;
  showHorizonControl?: boolean;
  showDemoLabel?: boolean;
  freshnessLabel?: string;
  interactive?: boolean;
  ariaLabel?: string;
};
