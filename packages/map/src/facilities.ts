/// <reference path="./geojson.d.ts" />
import source from "../../../fixtures/chennai-demo/osm-places.geojson?raw";
import type { MapPosition } from "./types";

export const facilityKinds = {
  HOSPITAL: { label: "Hospitals", color: "#a51c30" },
  POLICE: { label: "Police", color: "#064b9c" },
  FIRE_STATION: { label: "Fire stations", color: "#a94000" },
  SCHOOL: { label: "Schools", color: "#4e438d" },
  COLLEGE: { label: "Colleges", color: "#4e438d" },
  COMMUNITY_CENTRE: { label: "Community centres", color: "#11694b" },
} as const;
export type FacilityKind = keyof typeof facilityKinds;
export type Facility = {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: MapPosition };
  properties: { id: string; kind: FacilityKind; name: string; source_url: string; [key: string]: unknown };
};
export type FacilityBaseline = {
  type: "FeatureCollection";
  features: Facility[];
  source_snapshot_at: string;
  attribution: string;
  notice: string;
};
export const facilityBaseline = JSON.parse(source) as FacilityBaseline;
export const defaultFacilityKinds: FacilityKind[] = ["HOSPITAL", "POLICE", "FIRE_STATION"];

export function facilityDistance(feature: Facility, origin: MapPosition): number {
  const [lon, lat] = feature.geometry.coordinates;
  const radians = Math.PI / 180;
  const a = Math.sin((lat - origin[1]) * radians / 2) ** 2
    + Math.cos(lat * radians) * Math.cos(origin[1] * radians)
    * Math.sin((lon - origin[0]) * radians / 2) ** 2;
  return Math.round(6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, a))));
}

export function findMapFacilities(kinds: FacilityKind[], query = "", origin?: MapPosition, baseline = facilityBaseline): Facility[] {
  const needle = query.trim().toLocaleLowerCase();
  const matches = baseline.features.filter((feature) => kinds.includes(feature.properties.kind)
    && [feature.properties.name, feature.properties.name_en, feature.properties.name_ta, feature.properties.name_hi, feature.properties.name_ml]
      .some((name) => typeof name === "string" && name.toLocaleLowerCase().includes(needle)));
  return origin ? matches.map((feature) => ({ feature, distance: facilityDistance(feature, origin) }))
    .sort((a, b) => a.distance - b.distance || a.feature.id.localeCompare(b.feature.id)).map(({ feature }) => feature) : matches;
}

export function facilitySourceUrl(feature: Facility): string {
  return `https://www.openstreetmap.org/${feature.properties.osm_type}/${feature.properties.osm_id}`;
}
