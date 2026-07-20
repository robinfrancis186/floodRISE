import assert from "node:assert/strict";
import test from "node:test";
import {
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
      tags: { name: "Velachery Main Road", highway: "primary", surface: "asphalt" },
      geometry: [{ lat: 12.98, lon: 80.22 }, { lat: 12.981, lon: 80.221 }],
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

test("normalizes an OSM way into bounded deterministic GeoJSON", () => {
  const normalized = normalizeOverpassPayload(payload());
  assert.equal(normalized.snapshotTime, "2026-07-20T12:30:00Z");
  assert.deepEqual(normalized.features[0], {
    type: "Feature",
    id: "osm-way-123",
    geometry: {
      type: "LineString",
      coordinates: [[80.22, 12.98], [80.221, 12.981]],
    },
    properties: {
      id: "osm-way-123",
      kind: "route",
      name: "Velachery Main Road",
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
      geometry: [{ lat: 12.98, lon: 80.22 }, { lat: 14, lon: 80.221 }],
    })),
    /outside the approved Chennai AOI/,
  );
});

test("fails closed when a streamed response exceeds its byte limit", async () => {
  const response = new Response(JSON.stringify(payload()), {
    headers: { "Content-Type": "application/json" },
  });
  await assert.rejects(() => readBoundedJson(response, 16), /response exceeds/);
});
