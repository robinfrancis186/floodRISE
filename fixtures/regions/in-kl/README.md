# Kerala OpenStreetMap facility baseline

`osm-places.geojson` is a statewide OpenStreetMap snapshot of named hospitals,
schools, colleges, community centres, police stations, and fire stations inside
the Kerala state boundary, captured through the Overpass API at
`2026-10-06T07:47:06Z`. It is distributed under the Open Data Commons Open
Database License (ODbL) 1.0. Attribution: `© OpenStreetMap contributors`.

These are community-mapped locations with `is_simulated: false`. Coverage and
tagging quality vary by district, some entries are mis-tagged, and nothing here
confirms a facility is open, reachable, or an activated relief camp. The bundle
contains no flood model, incident scenario, or road network.

To keep the file small, null properties are omitted and `id`, `source`, and
`source_url` are derived from the feature id. Regenerate with
`pnpm osm:import:places kerala`, then update the checksum in `manifest.json`.
