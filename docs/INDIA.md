# India deployment profile

floodRISE is built for Indian cities. The packaged scenario replays Cyclone
Michaung in Chennai, but the reference data, alert format, language support, and
time handling below apply nationally. Nothing here contacts IMD, CWC, NDMA, or any
other provider, and nothing here is an official warning.

## What is implemented

| Capability | Where | Notes |
| --- | --- | --- |
| Region registry | `GET /api/v1/india/regions`, `services/backend/app/india.py` | Twelve flood-prone urban regions with state code (ISO 3166-2:IN), approximate planning envelope, river basins, flood drivers, and language order. Only Chennai has packaged data (`data_status: DEMO_FIXTURE`); the rest are `REGISTERED_NO_DATA`. |
| Emergency helplines | `GET /api/v1/india/emergency-contacts`, field PWA `/helplines` | 112 first, then NDMA 1078, state 1070, district 1077, and service lines. City lines are added per region. Every entry is flagged `requires_local_verification`. The PWA list is packaged, so it opens offline and dials with `tel:` links. |
| IMD and CWC scales | `GET /api/v1/india/warning-scales`, `GET /api/v1/india/rainfall/classify` | IMD colour codes, IMD 24-hour rainfall intensity categories, and CWC flood-situation categories as reference scales. `classify_river_level` applies warning/danger/HFL thresholds supplied by the caller. |
| CAP 1.2 alert export | `GET /api/v1/alerts/{alert_id}/cap` | Serializes any floodRISE alert as OASIS Common Alerting Protocol 1.2, the format used by NDMA's SACHET platform. Times carry the `+05:30` offset. Demo alerts are `status: Exercise` with an explicit note; community cautions are `certainty: Possible` and carry `floodrise:official=false`. |
| Languages | Field PWA language selector | English, Hindi, and Tamil for the navigation shell, primary actions, and the helplines screen. The choice persists per device and sets the document language. |
| Time and number formats | Both web apps | Times render in IST (`Asia/Kolkata`) and counts use `en-IN` digit grouping. |

## Known limits

- **Translations need review.** Hindi and Tamil strings are first-pass
  translations and have not been reviewed by native speakers. The report form,
  queue, route, and alert body text are still English. Untranslated keys fall back
  to English rather than rendering blank.
- **Helplines are not verified here.** Numbers and routing differ by state,
  district, and telecom circle. The deploying authority must confirm each number
  and add its own district lines before public use.
- **Region envelopes are approximate.** They are planning rectangles, not surveyed
  municipal or ward boundaries, and must not be used to decide jurisdiction.
- **CAP export is a serializer, not a submission.** No alert is sent to SACHET or
  any aggregator. `FLOODRISE_CAP_SENDER` and `FLOODRISE_CAP_SENDER_NAME` default to
  an `.invalid` demo identity; an authority replaces them with its registered
  sender. Polygon alert areas are described by `areaDesc` only.
- **No live Indian data feeds.** IMD, CWC, and state sources stay permission-gated
  as described in [DATA_SOURCES.md](DATA_SOURCES.md).

## Adding a city

1. Add the region to `_REGIONS` in `services/backend/app/india.py` with
   `data_status: REGISTERED_NO_DATA`, and any verified city helpline to
   `_REGION_CONTACTS`.
2. Import an OpenStreetMap road baseline for the new area with
   `scripts/import-osm-baseline.mjs` (the area of interest is currently pinned to
   Chennai and must be extended deliberately).
3. Package a checksummed fixture bundle and depth rasters, then change
   `data_status` only once the bundle validates with `pnpm fixtures:validate`.
4. Add the region's primary language to the field PWA dictionaries in
   `apps/field-web/src/lib/i18n.tsx` and have it reviewed.

## Privacy

Personal data in reports falls under the Digital Personal Data Protection Act,
2023. The controls in [PRIVACY_RETENTION.md](PRIVACY_RETENTION.md) (purpose
limitation, minimization, retention deadlines, generalized public location) are
design inputs to that compliance work, not a legal determination. Notice and
consent text, a grievance contact, and data-principal request handling must be
supplied by the deploying authority as data fiduciary.
