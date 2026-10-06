# Self-hosted OpenStreetMap tiles

Put an OpenStreetMap tile archive (`.mbtiles` or `.pmtiles`) and, optionally, a
TileServer GL `config.json` in this directory, then start the tile server:

```bash
docker compose -f infra/compose.yaml --profile osm up -d
```

Archives are not committed (see `.gitignore`). Build one from a
[Geofabrik India extract](https://download.geofabrik.de/asia/india.html) with an
open-source generator such as Planetiler or tilemaker, and keep the extract date
and `© OpenStreetMap contributors` attribution with it.

The server runs on the isolated demo network with no internet access, so any
style it serves must bundle its own fonts and sprites.
