# Data-source registry and onboarding policy

No adapter is “live” merely because it returns data. Before activation, the data
owner records provider, source URL/ID, licence, attribution, permitted storage and
redistribution, observed/acquired/issued and ingestion times, validity window,
coverage, confidence, quality flags, checksum, version, raw artifact reference,
and `is_simulated`.

## Planned registry

| Source | Intended use | Access and handling |
| --- | --- | --- |
| [Copernicus Global Flood Monitoring](https://global-flood.emergency.copernicus.eu/react/general-information/data-and-services/) | Observed flood-extent corroboration | Register and verify current product terms, latency, quality flags, and attribution before activation. Keep acquisition time distinct from observation time. |
| [Copernicus GLO-30 DEM](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM) | Terrain conditioning and HAND/D8 baseline | Pin product/version and licence text; retain source attribution in derived manifests. |
| [Geofabrik Southern Zone extract](https://download.geofabrik.de/asia/india/southern-zone.html) / OpenStreetMap | Roads, bridges, land use, and candidate facilities | The demo packages a small Overpass-derived Chennai road snapshot; production uses the versioned Geofabrik extract. Preserve `© OpenStreetMap contributors`, ODbL obligations, extract date, and replication/version information. Never depend on public OSM tiles for emergency runtime. |
| GHSL | Population exposure baseline | Record product release, grid resolution, CRS, reuse terms, and aggregation method. Do not present gridded estimates as a current census count. |
| Census of India 2011 | Administrative population context | Retain year prominently and verify current government reuse terms. Never imply 2011 counts are present-day values. |
| Vetted authority shelter/hospital lists | Shelter reachability and critical assets | Require named owner, review date, capacity semantics, update route, and permission to publish. Unknown capacity remains unknown. |
| [IMD API](https://api.imd.gov.in/public/api_reference.html) | Weather warnings, rainfall, and forecasts | Credentialed adapter only; obey current API terms and attribution. Never commit credentials or scrape a replacement endpoint. |
| CWC/NWDP approved access | Gauge levels and flood forecasts | Activate only with written/contractual access, station metadata, datum/unit checks, freshness limits, and redistribution approval. |
| Chennai Flood Monitor / GCC GIS | Local drainage, roads, shelters, and authority context | Permission-gated. Do not scrape, mirror, or redistribute without written authorization. |
| Community and responder reports | Rapid ground evidence | Purpose-limited, deduplicated, independence-checked, time-expiring, privacy-minimized, and never described as official confirmation. |

Provider links and terms change. The data steward rechecks the primary source at
onboarding and each quarter; this document is not itself a licence grant.

## Acceptance checklist

1. Validate CRS, longitude/latitude order, units, timezone, nodata values, and
   spatial/temporal coverage against a known fixture.
2. Capture the raw artifact privately and calculate SHA-256 before normalization.
3. Run schema, freshness, range, duplicate, and completeness checks. Quarantine
   rather than coerce an ambiguous datum or elevation datum.
4. Compare a sample with the provider's human-facing source and record evidence.
5. Assign freshness and confidence policy, failure fallback, data owner, and
   incident contact. Exercise a stale/outage case before enabling the adapter.
6. Obtain security/privacy approval for identity, media, or precise location.
7. Mark live/simulated explicitly and test that a live incident rejects a demo
   artifact identifier.

## Deterministic replay

`fixtures/chennai-demo` is privacy-safe. Its flood-response observations, impacts,
statuses, and operational decisions are synthetic; `osm-baseline.geojson` is a
separately attributed OpenStreetMap road snapshot with `is_simulated: false`.
The scenario manifest pins hashes, clock, incident/model/evidence versions,
disabled live integrations, and a fake notification sink. Scenario data may
resemble official data shapes but contains no restricted extract, real citizen
identity, or destination.
Its nested raster manifest also pins each georeferenced PGM depth grid by
SHA-256, version, model, validity, confidence, rendering scale, and input
provenance. Those packaged grids are offline rapid impact estimates, not COGs or
live/certified depth products.

If a fixture changes, update the manifest checksum and scenario version, explain
the change, rerun three clean rehearsals, and retain the prior bundle for audit.
