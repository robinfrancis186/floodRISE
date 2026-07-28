import { describe, expect, it } from "vitest";
import { appPathForView, normalizeAppBase, viewFromAppPath } from "./app-paths";

describe("operations application paths", () => {
  it("keeps development routes at the origin root", () => {
    expect(normalizeAppBase("/")).toBe("");
    expect(appPathForView("signals", "/")).toBe("/signals");
    expect(viewFromAppPath("/signals", "/")).toBe("signals");
  });

  it("mounts production routes below the CloudFront operations prefix", () => {
    expect(normalizeAppBase("/ops/")).toBe("/ops");
    expect(appPathForView("live", "/ops/")).toBe("/ops/");
    expect(appPathForView("signals", "/ops/")).toBe("/ops/signals");
    expect(viewFromAppPath("/ops", "/ops/")).toBe("live");
    expect(viewFromAppPath("/ops/", "/ops/")).toBe("live");
    expect(viewFromAppPath("/ops/signals", "/ops/")).toBe("signals");
  });

  it("does not interpret another application prefix as an operations route", () => {
    expect(viewFromAppPath("/field/alerts", "/ops/")).toBe("live");
  });
});
