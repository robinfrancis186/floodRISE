# floodRISE Design System

The four approved concept images are the visual source of truth. The system uses a true white base, cool gray separators, deep navy text and primary controls, flood blue for selected and inundation states, coral for danger, amber for caution, and green for verified/open states.

## Tokens

| Role | Value |
| --- | --- |
| Canvas | `#ffffff` |
| Subtle surface | `#f6f8fb` |
| Border | `#dce2ea` |
| Text | `#0a1a3a` |
| Muted text | `#5d6879` |
| Primary navy | `#062d78` |
| Flood blue | `#1468e8` |
| Flood fill | `#8fd3ff` at 45–58% opacity |
| Danger | `#e3242b` |
| Warning | `#ed8b00` |
| Success | `#14833b` |

Use Inter with system sans-serif fallbacks, tabular numbers, an 8px spacing grid, 8–12px radii, one-pixel borders, and minimal shadow. Controls are code-native and at least 44px on field/mobile surfaces.

## Component families

- Top application bar and bottom source-status rail.
- Compact left navigation and layer controls.
- Map canvas with native layer legend, time scrubber, markers, flood polygons, routes, and closures.
- Row-based queues and evidence tables; do not convert them to card grids.
- Right-side evidence/decision inspector on desktop and bottom drawer on mobile.
- Buttons: navy primary, neutral outline secondary, destructive outline, and text action.
- Status labels always pair color with icon/text.

## Copy lock

Primary visible strings follow the concepts: `Live Operations`, `FloodSignal Review`, `Resilience Audit`, `Report flooding`, `Approve action`, `Verify flooding`, `Request field check`, `Reject cluster`, `Save report offline`, and `DEMO DATA • NOT LIVE`.

Safety wording is fixed: `community corroborated`, `not an official confirmation`, `rapid impact estimate`, `lower-risk route`, and `Do not enter floodwater to submit a report.` Never use `safe route`, `certified depth`, or automatic official-warning language.

## Responsive model

- Operations: optimized for 1366×768 and above; at narrow widths the inspector becomes a sheet and navigation collapses.
- Field: map occupies the upper viewport; the reporting workflow uses a scrollable bottom sheet and sticky submit action.
- Every map state has a synchronized list/table alternative for keyboard and assistive technology users.
