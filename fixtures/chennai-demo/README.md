# Chennai Cyclone Michaung deterministic replay

This fixture bundle is privacy-safe. Flood-response observations and impacts are synthetic, while `osm-baseline.geojson` is a packaged OpenStreetMap road snapshot with ODbL attribution. The bundle contains no real reporter identity, contact detail, notification destination, or restricted dataset extract.

The replay checkpoint starts at `2023-12-04T14:10:00Z`, after the four fixture observations at 14:02–14:08 UTC. Advancing the timeline introduces rainfall, model updates, the reports, a duplicate, a contradictory observation, a community-corroborated signal, a route change, and a two-person approval exercise.

Every scenario observation, model, impact, route, report, and decision sourced from this directory must retain `is_simulated: true` and the `DEMO DATA • NOT LIVE` watermark. The OSM road baseline remains separately attributed source data with `is_simulated: false`; it does not make the incident live. Demo incidents may only use the fake notification sink.

`rasters/manifest.json` pins two small, georeferenced ASCII PGM depth grids used
by the offline tile service. Each grid has an immutable content checksum,
model/version binding, validity window, confidence, input provenance, and
explicit centimetre-to-metre scale. They are packaged rapid impact estimates;
they are not COGs, live observations, or hydraulically certified flood depths.

Regenerate the road baseline with `pnpm osm:import`. Runtime maps use the packaged snapshot and never depend on OpenStreetMap tile servers or upstream internet.
