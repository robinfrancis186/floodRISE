import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredBasemapTileUrl, parseBasemapTileUrl } from "./basemap";
import { createMapStyle, initialViews } from "./style";

describe("OpenStreetMap basemap", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses direct OSM tiles by default, allows an override, and supports explicit offline mode", () => {
    vi.stubEnv("VITE_OSM_TILE_URL", undefined);
    expect(configuredBasemapTileUrl()).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    vi.stubEnv("VITE_OSM_TILE_URL", "https://tiles.example.in/{z}/{x}/{y}.png");
    expect(configuredBasemapTileUrl()).toBe("https://tiles.example.in/{z}/{x}/{y}.png");
    vi.stubEnv("VITE_OSM_TILE_URL", "");
    expect(configuredBasemapTileUrl()).toBeNull();
  });
  it("accepts HTTPS and loopback tile templates", () => {
    expect(parseBasemapTileUrl(" https://tiles.example.in/osm/{z}/{x}/{y}.png ")).toBe(
      "https://tiles.example.in/osm/{z}/{x}/{y}.png",
    );
    expect(parseBasemapTileUrl("http://localhost:8080/styles/basic/{z}/{x}/{y}.png")).not.toBeNull();
    expect(parseBasemapTileUrl("http://127.0.0.1:8080/{z}/{x}/{y}.png")).not.toBeNull();
  });

  it("stays off when unset or malformed", () => {
    for (const value of [undefined, null, "", 42, "not a url/{z}/{x}/{y}", "https://tiles.example.in/{z}/{x}.png"]) {
      expect(parseBasemapTileUrl(value)).toBeNull();
    }
  });

  it("refuses plain HTTP hosts, credentials, and other schemes", () => {
    for (const value of [
      "http://tiles.example.in/{z}/{x}/{y}.png",
      "https://user:secret@tiles.example.in/{z}/{x}/{y}.png",
      "file:///tiles/{z}/{x}/{y}.png",
    ]) {
      expect(parseBasemapTileUrl(value), value).toBeNull();
    }
  });
});


it("keeps street details visible under flood overlays and permits building-level zoom", () => {
  const style = createMapStyle("operations", "3h", "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  const layer = (id: string) => style.layers.find((item) => item.id === id)!;
  expect(layer("basemap")).toMatchObject({ paint: { "raster-opacity": 1 } });
  expect(layer("ward-fill")).toMatchObject({ paint: { "fill-opacity": 0 } });
  for (const id of ["road-line", "road-casing", "marsh-fill", "river-line", "river-casing"]) {
    expect(layer(id)).toMatchObject({ layout: { visibility: "none" } });
  }
  expect(layer("predicted-flood-3h-fill")).toMatchObject({ layout: { visibility: "visible" } });
  expect(layer("current-flood-fill")).toMatchObject({ paint: { "fill-opacity": 0.3 } });
  for (const view of Object.values(initialViews)) expect(view.maxZoom).toBe(19);
  expect(createMapStyle("field", "now").layers.find((item) => item.id === "road-line"))
    .toMatchObject({ layout: { visibility: "visible" } });
});
