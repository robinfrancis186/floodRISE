import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMapFallback,
  normalizeOverpassPayload,
  readBoundedJson,
  validateOverpassEndpoint,
} from "./import-osm-baseline.mjs";

function payload(overrides = {}) {
  return {
    osm3s: { timestamp_osm_base: "2026-07-20T12:30:00Z" },
    elements: [{
      type: "way",
      id: 123,
      tags: { name: "Aluva - Paravoor Road", highway: "primary", surface: "asphalt" },
      geometry: [{ lat: 10.105, lon: 76.351 }, { lat: 10.106, lon: 76.352 }],
      ...overrides,
    }],
  };
}

test("allows only the reviewed HTTPS Overpass endpoints", () => {
  assert.equal(
    validateOverpassEndpoint("https://overpass-api.de/api/interpreter"),
    "https://overpass-api.de/api/interpreter",
  );
  assert.throws(
    () => validateOverpassEndpoint("http://overpass-api.de/api/interpreter"),
    /allow-listed HTTPS/,
  );
  assert.throws(
    () => validateOverpassEndpoint("https://example.com/api/interpreter"),
    /allow-listed HTTPS/,
  );
});

test("builds a bounded map fallback that prioritizes major roads", () => {
  const primary = normalizeOverpassPayload(payload()).features[0];
  const tertiary = normalizeOverpassPayload(payload({
    id: 124,
    tags: { name: "HMT Road", highway: "tertiary" },
  })).features[0];
  const fallback = buildMapFallback([tertiary, primary], 1);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].properties.highway, "primary");
  assert.equal(fallback[0].properties.source, "OpenStreetMap");
});

test("normalizes an OSM way into bounded deterministic GeoJSON", () => {
  const normalized = normalizeOverpassPayload(payload());
  assert.equal(normalized.snapshotTime, "2026-07-20T12:30:00Z");
  assert.deepEqual(normalized.features[0], {
    type: "Feature",
    id: "osm-way-123",
    geometry: {
      type: "LineString",
      coordinates: [[76.3510000, 10.1050000], [76.3520000, 10.1060000]],
    },
    properties: {
      id: "osm-way-123",
      kind: "route",
      name: "Aluva - Paravoor Road",
      description: "OpenStreetMap primary road segment",
      class: "primary",
      osm_type: "way",
      osm_id: "123",
      highway: "primary",
      bridge: null,
      tunnel: null,
      layer: null,
      surface: "asphalt",
      source: "OpenStreetMap",
      source_url: "https://www.openstreetmap.org/way/123",
      attribution: "© OpenStreetMap contributors",
      licence: "Open Data Commons Open Database License (ODbL) 1.0",
      is_simulated: false,
    },
  });
});

test("rejects duplicate ways and coordinates outside the approved AOI", () => {
  const duplicate = payload();
  duplicate.elements.push(structuredClone(duplicate.elements[0]));
  assert.throws(() => normalizeOverpassPayload(duplicate), /duplicated/);
  assert.throws(
    () => normalizeOverpassPayload(payload({
      geometry: [{ lat: 10.105, lon: 76.351 }, { lat: 14, lon: 76.352 }],
    })),
    /outside the approved Kerala AOI/,
  );
});

test("accepts unnamed major roads but rejects unreviewed classes and unsafe names", () => {
  const unnamed = normalizeOverpassPayload(payload({ tags: { highway: "tertiary" } }));
  assert.equal(unnamed.features[0].properties.name, "Unnamed local road · OSM 123");
  assert.throws(
    () => normalizeOverpassPayload(payload({ tags: { highway: "residential" } })),
    /highway tag is invalid/,
  );
  assert.throws(
    () => normalizeOverpassPayload(payload({ tags: { highway: "primary", name: "<script>" } })),
    /road name is invalid/,
  );
});

test("fails closed when a streamed response exceeds its byte limit", async () => {
  const response = new Response(JSON.stringify(payload()), {
    headers: { "Content-Type": "application/json" },
  });
  await assert.rejects(() => readBoundedJson(response, 16), /response exceeds/);
});
