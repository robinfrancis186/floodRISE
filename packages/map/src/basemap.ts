// Browser requests honour OSM caching headers; never prefetch these tiles for offline use.
const DEFAULT_OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const PLACEHOLDERS = ["{z}", "{x}", "{y}"] as const;

declare global {
  interface ImportMetaEnv {
    readonly VITE_OSM_TILE_URL?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

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
  return template;
}

export function configuredBasemapTileUrl(): string | null {
  return parseBasemapTileUrl(import.meta.env?.VITE_OSM_TILE_URL ?? DEFAULT_OSM_TILE_URL);
}
