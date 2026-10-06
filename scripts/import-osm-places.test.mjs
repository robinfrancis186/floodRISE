import assert from "node:assert/strict";
import test from "node:test";
import { FACILITY_KINDS, normalizePlacesPayload } from "./import-osm-places.mjs";

const payload = (elements) => ({ osm3s: { timestamp_osm_base: "2026-10-06T07:37:51Z" }, elements });

test("normalizes nodes and way centres into deterministic attributed points", () => {
  const { features, snapshotTime } = normalizePlacesPayload(payload([
    { type: "way", id: 20, center: { lat: 12.98, lon: 80.22 }, tags: { amenity: "school", name: "B School" } },
    {
      type: "node", id: 3, lat: 12.9812345678, lon: 80.2201234567,
      tags: { amenity: "hospital", name: "  A‮ Hospital\n", "name:ta": "மருத்துவமனை", emergency: "yes" },
    },
  ]));
  assert.equal(snapshotTime, "2026-10-06T07:37:51Z");
  assert.deepEqual(features.map((feature) => feature.id), ["osm-node-3", "osm-way-20"]);
  assert.deepEqual(features[0].geometry.coordinates, [80.220123, 12.981235]);
  assert.equal(features[0].properties.name, "A Hospital");
  assert.equal(features[0].properties.name_ta, "மருத்துவமனை");
  assert.equal(features[0].properties.kind, "HOSPITAL");
  assert.equal(features[0].properties.emergency, true);
  assert.equal(features[0].properties.is_simulated, false);
  assert.equal(features[1].properties.source_url, "https://www.openstreetmap.org/way/20");
  assert.ok(FACILITY_KINDS.includes("COMMUNITY_CENTRE"));
});

test("skips unnamed, unsupported, and out-of-area places", () => {
  const { features } = normalizePlacesPayload(payload([
    { type: "node", id: 1, lat: 12.98, lon: 80.22, tags: { amenity: "hospital" } },
    { type: "node", id: 2, lat: 12.98, lon: 80.22, tags: { amenity: "casino", name: "X" } },
    { type: "node", id: 3, lat: 51.5, lon: -0.12, tags: { amenity: "hospital", name: "London" } },
    { type: "node", id: 4, lat: 12.98, lon: 80.22, tags: { amenity: "police", name: "x".repeat(121) } },
    { type: "relation", id: 5, center: { lat: 12.98, lon: 80.22 }, tags: { amenity: "school", name: "R" } },
  ]));
  assert.deepEqual(features, []);
});

test("rejects malformed payloads and duplicate identifiers", () => {
  assert.throws(() => normalizePlacesPayload(null), /JSON object/);
  assert.throws(() => normalizePlacesPayload({ elements: "nope" }), /element collection/);
  const place = { type: "node", id: 7, lat: 12.98, lon: 80.22, tags: { amenity: "police", name: "P" } };
  assert.throws(() => normalizePlacesPayload(payload([place, place])), /duplicated/);
  assert.throws(
    () => normalizePlacesPayload(payload([{ ...place, id: -1 }])),
    /identifier is invalid/,
  );
  assert.throws(
    () => normalizePlacesPayload({ osm3s: { timestamp_osm_base: "yesterday" }, elements: [] }),
    /timestamp is invalid/,
  );
});
