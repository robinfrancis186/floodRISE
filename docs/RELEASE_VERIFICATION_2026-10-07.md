# Release verification — 7 October 2026

This record covers application commits `7c8a718` and `8f5b126`, before the
subsequent documentation update. It extends the [6 October record](RELEASE_VERIFICATION_2026-10-06.md).

## Local checks

- 62 web unit tests passed: 22 operations, 32 field, 6 map, 2 browser-session.
- All 17 Playwright journeys passed, including desktop/mobile navigation,
  accessibility smoke scans, Kerala search/filter/region switching, failed
  snapshot recovery, report-pin coordinates and submission, and offline reuse
  of the Kerala snapshot in the built PWA.
- TypeScript, lint/format, fixture checksums, import/release script checks,
  generated OpenAPI drift, and the combined release build passed.
- A regression check confirms selecting a facility does not scroll the map
  canvas and that the places panel stays above visible attribution.

## Hosted evidence

- Vercel marked deployment `dpl_36JayCHUwiFvMP79D4L2FM9gHZQU` READY and aliased
  it to [floodrise.vercel.app](https://floodrise.vercel.app/).
- The served Kerala GeoJSON contained 23,586 records and matched the packaged
  snapshot checksum. Operations and field asset paths returned successfully.
- Computer Use inspection exercised detailed OSM tiles, region selection,
  category filters, search, facility selection, and grouped marker zoom.
- Representative original OSM records were inspected: Velachery Police Station
  (`node/8645780209`), a Chennai fire station (`node/5354315736`), and General
  Hospital Ernakulam (`way/755600802`). This was not individual verification of
  every facility or its current operational status.
- The published inspection found a places-panel scroll/clipping defect. It was
  corrected in `8f5b126`, redeployed, and checked on the published map.
- [CI](https://github.com/robinfrancis186/floodRISE/actions/runs/37577347053)
  and [security gates](https://github.com/robinfrancis186/floodRISE/actions/runs/37577347128)
  completed successfully for `8f5b126`. Security gates included CodeQL for
  JavaScript/TypeScript and Python, Gitleaks, and Trivy; dependency review was
  skipped on the push event.

## Scope and remaining work

Kerala is a community-mapped geographic baseline, not a flood scenario. Facility
availability, tagging accuracy, entrances, road access, and relief-camp
activation remain unverified. Straight-line distances are not route guidance.
The PWA retains a downloaded facility snapshot, not an offline street-tile
archive; browser tests use mocked street tiles to avoid bulk community requests.

The public release remains a read-only demo without a hosted backend or OIDC
provider. Local deterministic workflows and protocol-stub tests do not prove
hosted database/object durability, real scanning, provider ingestion, alert
sending, physical-device accessibility, load capacity, or backup recovery.
Builds still warn about large map/entry chunks.

See [implementation status](IMPLEMENTATION_STATUS.md) for unfinished code and
activation work, and [deployment setup](DEPLOYMENT.md) for configuration.
