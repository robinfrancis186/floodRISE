import { describe, expect, it } from "vitest";
import { parseBasemapTileUrl } from "./basemap";

describe("optional self-hosted basemap", () => {
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

  it("refuses public OSM tile servers, plain HTTP hosts, credentials, and other schemes", () => {
    for (const value of [
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
      "https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
      "http://tiles.example.in/{z}/{x}/{y}.png",
      "https://user:secret@tiles.example.in/{z}/{x}/{y}.png",
      "file:///tiles/{z}/{x}/{y}.png",
    ]) {
      expect(parseBasemapTileUrl(value), value).toBeNull();
    }
  });
});
