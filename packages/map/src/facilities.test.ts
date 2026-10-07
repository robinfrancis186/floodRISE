import { expect, it } from "vitest";
import { defaultFacilityKinds, facilityBaseline, facilityDistance, facilitySourceUrl, findMapFacilities } from "./facilities";

it("filters attributed real facilities and sorts straight-line distances without changing the snapshot", () => {
  expect(facilityBaseline.features).toHaveLength(637);
  expect(facilityBaseline.attribution).toContain("OpenStreetMap");
  const police = findMapFacilities(["POLICE"], "  velachery police station ")[0];
  expect(police.properties.name).toBe("Velachery Police Station");
  expect(facilitySourceUrl(police)).toBe("https://www.openstreetmap.org/node/8645780209");
  expect(facilityDistance(police, police.geometry.coordinates)).toBe(0);
  expect(findMapFacilities([], "")).toEqual([]);
  const nearest = findMapFacilities(defaultFacilityKinds, "", [80.2209, 12.9791]);
  expect(nearest.every((item) => defaultFacilityKinds.includes(item.properties.kind))).toBe(true);
  expect(nearest.map((item) => facilityDistance(item, [80.2209, 12.9791])))
    .toEqual(nearest.map((item) => facilityDistance(item, [80.2209, 12.9791])).sort((a, b) => a - b));
  expect(facilityBaseline.features[0].id).toBe("osm-node-248420920");
  expect(findMapFacilities(["HOSPITAL"], "definitely no such hospital")).toEqual([]);
});
