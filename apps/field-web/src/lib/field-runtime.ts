import { DEMO_INCIDENT_ID, DEMO_SCENARIO_TIME } from "../data/demo";

export type DemoFieldRuntime = {
  mode: "demo";
  incidentId: typeof DEMO_INCIDENT_ID;
  referenceTime: typeof DEMO_SCENARIO_TIME;
  incidentName: "Kerala extreme-rainfall deterministic replay";
  areaName: "Aluva, Kerala";
  incidentStatus: "ACTIVE";
};

export type LiveFieldRuntime = {
  mode: "live";
  incidentId: string | null;
  referenceTime: string | null;
  incidentName: string | null;
  areaName: string | null;
  incidentStatus: string | null;
};

export type FieldRuntime = DemoFieldRuntime | LiveFieldRuntime;

export const DEMO_FIELD_RUNTIME: DemoFieldRuntime = {
  mode: "demo",
  incidentId: DEMO_INCIDENT_ID,
  referenceTime: DEMO_SCENARIO_TIME,
  incidentName: "Kerala extreme-rainfall deterministic replay",
  areaName: "Aluva, Kerala",
  incidentStatus: "ACTIVE",
};

export const UNAVAILABLE_LIVE_FIELD_RUNTIME: LiveFieldRuntime = {
  mode: "live",
  incidentId: null,
  referenceTime: null,
  incidentName: null,
  areaName: null,
  incidentStatus: null,
};

export function hasAuthoritativeIncident(
  runtime: FieldRuntime,
): runtime is LiveFieldRuntime & { incidentId: string; referenceTime: string } | DemoFieldRuntime {
  return Boolean(runtime.incidentId && runtime.referenceTime);
}
