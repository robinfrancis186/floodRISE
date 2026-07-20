# Restricted raster tile service

This service exposes only artifact IDs listed in the Chennai deterministic
replay manifest. It never accepts a source URL from a client.

For the offline competition path it loads two georeferenced ASCII PGM depth
grids from `fixtures/chennai-demo/rasters`, verifies their SHA-256 checksums and
metadata at startup, then samples the fixed values into PNG web-map tiles. Its
TileJSON response identifies the model version, artifact version and checksum,
validity, confidence, simulation label, rendering method, and input provenance.
Version-derived ETags make the output cacheable and reproducible.

This implementation is intentionally lightweight and deterministic. It is not
TiTiler, does not read Cloud Optimized GeoTIFFs, and must not be described as the
production COG path. Before production raster traffic is enabled, replace or
extend this demo adapter with a locked-down COG/TiTiler implementation that
reads only private, allow-listed object-store artifacts and retains the same
version/provenance contract. The service fails at startup if this packaged demo
adapter is launched with `FLOODRISE_ENV=production` (or `prod`/`live`).

Run focused checks from the repository root:

```bash
cd services/tile-api
uv run ruff check .
uv run ruff format --check .
uv run pytest
```
