import { describe, expect, it } from "vitest";
import { demoSnapshot } from "./demo";

describe("operations replay checkpoint", () => {
  it("uses the backend reset checkpoint and has no future source observations", () => {
    const checkpoint = Date.parse(demoSnapshot.scenarioTime);

    expect(demoSnapshot.scenarioTime).toBe("2023-12-04T14:10:00Z");
    expect(demoSnapshot.sources.every((source) => Date.parse(source.observed_at) <= checkpoint)).toBe(true);
  });

  it("does not label an expired deterministic route as an available alternative", () => {
    const checkpoint = Date.parse(demoSnapshot.scenarioTime);

    expect(demoSnapshot.routes.every((route) => Date.parse(route.valid_until) > checkpoint)).toBe(true);
  });
});
