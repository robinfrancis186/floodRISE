/**
 * Optional raster basemap from a self-hosted OpenStreetMap tile server.
 *
 * The default map is fully packaged and makes no network requests. A deployment
 * that runs its own open-source tile server (for example TileServer GL or
 * Martin over a Geofabrik extract) can set `VITE_OSM_TILE_URL` to add it
 * underneath the flood layers. The community-run openstreetmap.org tile servers
 * are refused: their usage policy does not permit depending on them for an
 * emergency service, and they may be unreachable exactly when needed.
 */

const PUBLIC_OSM_TILE_HOST = /(^|\.)tile\.openstreetmap\.(org|fr|de)$|(^|\.)openstreetmap\.org$/i;
const PLACEHOLDERS = ["{z}", "{x}", "{y}"] as const;

export function parseBasemapTileUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const template = value.trim();
  if (!template || PLACEHOLDERS.some((placeholder) => !template.includes(placeholder))) return null;

  let url: URL;
  try {
    // Substitute the placeholders so the template parses as a concrete URL.
    url = new URL(template.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0"));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  // Plain HTTP is only acceptable for a tile server on the developer's machine.
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && !isLoopback) return null;
  if (PUBLIC_OSM_TILE_HOST.test(url.hostname)) return null;
  return template;
}

export function configuredBasemapTileUrl(): string | null {
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  return parseBasemapTileUrl(env?.VITE_OSM_TILE_URL);
}
