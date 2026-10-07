import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  Map as MapLibreMap,
  MapGeoJSONFeature,
  Marker as MapLibreMarker,
} from "maplibre-gl";

import { Facilities } from "./FacilityPlaces";
import { configuredBasemapTileUrl } from "./basemap";
import { chennaiMapData } from "./data/chennai";
import {
  createMapStyle,
  initialViews,
  interactiveLayerIds,
  updateHorizonLayers,
} from "./style";
import type {
  FloodMapProps,
  FloodMapSelection,
  FloodMapVariant,
  MapFeature,
  MapFeatureCollection,
  MapFeatureKind,
  MapFeatureProperties,
  MapGeometry,
  MapHorizon,
  MapPosition,
} from "./types";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

type MapLibrary = typeof import("maplibre-gl");
type PointFeature = MapFeature<{ type: "Point"; coordinates: MapPosition }>;
type LoadState = "loading" | "ready" | "error";

const DEFAULT_ARIA_LABELS: Record<FloodMapVariant, string> = {
  operations: "Live operations flood intelligence map for south Chennai",
  signals: "FloodSignal evidence review map for Velachery",
  resilience: "Chennai resilience audit priority map",
  field: "Current conditions and community reports map near Velachery",
};

const HORIZON_LABELS: Record<MapHorizon, string> = {
  now: "Now",
  "1h": "+1h",
  "3h": "+3h",
};

const DEFAULT_HORIZONS: Record<FloodMapVariant, MapHorizon> = {
  operations: "now",
  signals: "now",
  resilience: "now",
  field: "3h",
};

const HORIZON_DESCRIPTIONS: Record<MapHorizon, string> = {
  now: "current rapid impact estimate",
  "1h": "one-hour rapid impact estimate",
  "3h": "three-hour rapid impact estimate",
};

const kindLabels: Record<MapFeatureKind, string> = {
  ward: "ward",
  flood: "flood estimate",
  closure: "road status",
  route: "route",
  shelter: "shelter",
  hospital: "hospital",
  report: "ground report",
  cluster: "report cluster",
  hotspot: "resilience hotspot",
  resilience_issue: "resilience issue",
  place: "place",
};

function isPointFeature(feature: MapFeature): feature is PointFeature {
  return feature.geometry.type === "Point";
}

function pointFeatures(collection: MapFeatureCollection): PointFeature[] {
  return collection.features.filter(isPointFeature);
}

function featureToSelection(feature: MapFeature): FloodMapSelection {
  return {
    id: feature.properties.id,
    kind: feature.properties.kind,
    name: feature.properties.name,
    description: feature.properties.description,
    confidence: feature.properties.confidence,
    coordinates: feature.geometry.type === "Point" ? feature.geometry.coordinates : undefined,
    properties: feature.properties,
  };
}

function renderedFeatureToSelection(feature: MapGeoJSONFeature): FloodMapSelection | null {
  const raw = feature.properties as Partial<MapFeatureProperties> | null;
  if (!raw?.id || !raw.kind || !raw.name) return null;

  const properties = raw as MapFeatureProperties;
  const coordinates = feature.geometry.type === "Point"
    ? (feature.geometry.coordinates.slice(0, 2) as MapPosition)
    : undefined;

  return {
    id: properties.id,
    kind: properties.kind,
    name: properties.name,
    description: properties.description,
    confidence: typeof properties.confidence === "number" ? properties.confidence : undefined,
    coordinates,
    properties,
  };
}

function markerFeaturesForVariant(variant: FloodMapVariant): PointFeature[] {
  const clusterPoints = pointFeatures(chennaiMapData.clusters);

  switch (variant) {
    case "signals":
      return [
        ...chennaiMapData.reports.features,
        ...clusterPoints.filter((feature) => feature.properties.id === "cluster-velachery"),
        ...chennaiMapData.shelters.features.slice(0, 2),
        ...chennaiMapData.hospitals.features.slice(1),
      ];
    case "resilience":
      return [
        ...chennaiMapData.resilienceHotspots.features,
        ...chennaiMapData.shelters.features,
        ...chennaiMapData.hospitals.features,
      ];
    case "field":
      return [
        ...clusterPoints.filter((feature) => feature.properties.id === "cluster-velachery"),
        ...chennaiMapData.shelters.features.slice(0, 2),
      ];
    case "operations":
    default:
      return [
        ...clusterPoints,
        ...chennaiMapData.shelters.features,
        ...chennaiMapData.hospitals.features,
      ];
  }
}

function summaryFeaturesForVariant(variant: FloodMapVariant): PointFeature[] {
  switch (variant) {
    case "signals":
      return [
        pointFeatures(chennaiMapData.clusters).find((feature) => feature.properties.id === "cluster-velachery")!,
        chennaiMapData.reports.features.find((feature) => feature.properties.id === "report-duplicate")!,
        chennaiMapData.reports.features.find((feature) => feature.properties.id === "report-conflict")!,
      ];
    case "resilience":
      return chennaiMapData.resilienceHotspots.features.slice(0, 4);
    case "field":
      return [
        pointFeatures(chennaiMapData.clusters).find((feature) => feature.properties.id === "cluster-velachery")!,
        chennaiMapData.shelters.features[0]!,
        chennaiMapData.shelters.features[1]!,
      ];
    case "operations":
    default:
      return [
        pointFeatures(chennaiMapData.clusters).find((feature) => feature.properties.id === "cluster-velachery")!,
        chennaiMapData.shelters.features[0]!,
        chennaiMapData.shelters.features[1]!,
        chennaiMapData.hospitals.features[0]!,
      ];
  }
}

function markerClass(feature: PointFeature): string {
  const { kind, class: className, status } = feature.properties;
  const tokens = ["fr-map-marker", `fr-map-marker--${kind}`];
  if (className) tokens.push(`fr-map-marker--${className}`);
  if (status) tokens.push(`fr-map-marker--status-${status}`);
  return tokens.join(" ");
}

function markerText(feature: PointFeature): string {
  switch (feature.properties.kind) {
    case "cluster":
      return String(feature.properties.count ?? "");
    case "report":
      if (feature.properties.class === "duplicate") return "D1";
      if (feature.properties.class === "conflict") return "C1";
      return String(feature.properties.count ?? "•");
    case "hotspot":
      return String(feature.properties.rank ?? "•");
    case "hospital":
      return "H";
    case "shelter":
      return "";
    default:
      return "•";
  }
}

function createShelterIcon(): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const roof = document.createElementNS(namespace, "path");
  roof.setAttribute("d", "M3.5 11.1 12 4l8.5 7.1");
  roof.setAttribute("fill", "none");
  roof.setAttribute("stroke", "currentColor");
  roof.setAttribute("stroke-width", "2.2");
  roof.setAttribute("stroke-linecap", "round");
  roof.setAttribute("stroke-linejoin", "round");

  const home = document.createElementNS(namespace, "path");
  home.setAttribute("d", "M6.2 10.4V20h11.6v-9.6M10 20v-5.6h4V20");
  home.setAttribute("fill", "none");
  home.setAttribute("stroke", "currentColor");
  home.setAttribute("stroke-width", "2.2");
  home.setAttribute("stroke-linecap", "round");
  home.setAttribute("stroke-linejoin", "round");

  svg.append(roof, home);
  return svg;
}

function createMarkerElement(
  feature: PointFeature,
  variant: FloodMapVariant,
  selected: boolean,
  onSelect: (selection: FloodMapSelection) => void,
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `${markerClass(feature)}${selected ? " is-selected" : ""}`;
  element.setAttribute(
    "aria-label",
    `${kindLabels[feature.properties.kind]}: ${feature.properties.name}. ${feature.properties.description ?? ""}`.trim(),
  );
  element.title = feature.properties.description
    ? `${feature.properties.name} — ${feature.properties.description}`
    : feature.properties.name;

  const icon = document.createElement("span");
  icon.className = "fr-map-marker__icon";
  icon.setAttribute("aria-hidden", "true");
  if (feature.properties.kind === "shelter") {
    icon.append(createShelterIcon());
  } else {
    icon.textContent = markerText(feature);
  }
  element.append(icon);

  const shouldLabel =
    (feature.properties.kind === "shelter" || feature.properties.kind === "hospital") &&
    (variant !== "field" || feature.properties.id === "shelter-velachery");
  if (shouldLabel) {
    const label = document.createElement("span");
    label.className = "fr-map-marker__label";
    label.textContent = feature.properties.name;
    label.setAttribute("aria-hidden", "true");
    element.append(label);
  }

  element.addEventListener("click", (event) => {
    event.stopPropagation();
    onSelect(featureToSelection(feature));
  });

  return element;
}

function createPlaceLabel(feature: PointFeature): HTMLDivElement {
  const label = document.createElement("div");
  label.className = `fr-map-place-label fr-map-place-label--${feature.properties.class ?? "district"}`;
  label.textContent = feature.properties.name;
  label.setAttribute("aria-hidden", "true");
  return label;
}

function summaryCopy(variant: FloodMapVariant, horizon: MapHorizon): string {
  const horizonCopy = HORIZON_DESCRIPTIONS[horizon];
  switch (variant) {
    case "signals":
      return `Velachery FloodSignal evidence view with 6 eligible independent reports, 1 excluded duplicate, 1 possible conflict, and 92 percent confidence. ${horizonCopy} is selected.`;
    case "resilience":
      return "Chennai resilience audit showing 6 of 18 recurring hotspots, 11 road bottlenecks, 4 shelter access gaps, and 72 percent of people within 30 minutes of an eligible shelter.";
    case "field":
      return `Current conditions near Velachery with one community-corroborated report cluster, nearby shelters, and road risk. ${horizonCopy} is selected. Conditions may change.`;
    case "operations":
    default:
      return `South Chennai operations view with four current flood estimate areas, three road risk segments, five shelters, three hospitals, and three community report clusters. ${horizonCopy} is selected.`;
  }
}

function legendItems(variant: FloodMapVariant, horizon: MapHorizon) {
  if (variant === "resilience") {
    return [
      { swatch: "recurrence", label: "Recurrent flooding" },
      { swatch: "drainage", label: "Drainage bottleneck" },
      { swatch: "closure", label: "Road isolation" },
      { swatch: "shelter-gap", label: "Shelter access gap" },
      { swatch: "hospital", label: "Critical asset" },
    ];
  }

  const items = [
    { swatch: "current", label: "Current flooding" },
    ...(horizon === "now"
      ? []
      : [{ swatch: "predicted", label: `Predicted ${HORIZON_LABELS[horizon]}` }]),
  ];

  if (variant === "signals") {
    return [
      ...items,
      { swatch: "boundary", label: "Cluster boundary (250 m)" },
      { swatch: "report", label: "Eligible reports" },
      { swatch: "excluded", label: "Excluded / conflicting" },
      { swatch: "shelter", label: "Shelter" },
    ];
  }

  if (variant === "field") {
    return [
      ...items,
      { swatch: "closure", label: "Road at risk" },
      { swatch: "cluster", label: "Community reports" },
      { swatch: "shelter", label: "Shelter" },
    ];
  }

  return [
    ...items,
    { swatch: "closure", label: "Closed / at-risk road" },
    { swatch: "route", label: "Lower-risk route" },
    { swatch: "cluster", label: "Community reports" },
    { swatch: "shelter", label: "Shelter" },
  ];
}

function MarkerStatus({ state }: { state: LoadState }): ReactNode {
  if (state === "ready") return null;
  return (
    <div className={`fr-map-load-state fr-map-load-state--${state}`} role={state === "error" ? "alert" : "status"}>
      {state === "error"
        ? "Interactive map unavailable. The synchronized feature summary remains available below."
        : "Loading the Chennai map…"}
    </div>
  );
}

export function FloodMap({
  variant,
  horizon,
  onHorizonChange,
  selectedFeatureId,
  selectedLocation,
  onLocationSelect,
  onBaselineChange,
  allowRegionSwitch = false,
  onFeatureSelect,
  className,
  height,
  showSummary = true,
  showLegend = true,
  showHorizonControl = true,
  showDemoLabel = true,
  freshnessLabel,
  interactive = true,
  ariaLabel,
}: FloodMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const mapLibraryRef = useRef<MapLibrary | null>(null);
  const markersRef = useRef<MapLibreMarker[]>([]);
  const onFeatureSelectRef = useRef(onFeatureSelect);
  const onLocationSelectRef = useRef(onLocationSelect);
  const descriptionId = `flood-map-description-${useId().replaceAll(":", "")}`;

  const [internalHorizon, setInternalHorizon] = useState<MapHorizon>(DEFAULT_HORIZONS[variant]);
  const [internalSelection, setInternalSelection] = useState<FloodMapSelection | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [facilityRegion, setFacilityRegion] = useState<"chennai" | "kerala">("chennai");
  const [mapEpoch, setMapEpoch] = useState(0);
  const [basemapActive, setBasemapActive] = useState(Boolean(configuredBasemapTileUrl()));

  const selectingLocation = Boolean(onLocationSelect);
  const effectiveAriaLabel = facilityRegion === "kerala" ? "Kerala OpenStreetMap facility locations" : ariaLabel ?? DEFAULT_ARIA_LABELS[variant];
  const effectiveHorizon = horizon ?? internalHorizon;
  const activeFeatureId = selectedFeatureId !== undefined
    ? selectedFeatureId
    : internalSelection?.id ?? null;
  const summaryFeatures = useMemo(() => summaryFeaturesForVariant(variant), [variant]);
  const items = useMemo(() => legendItems(variant, effectiveHorizon), [variant, effectiveHorizon]);
  const screenReaderSummary = useMemo(
    () => summaryCopy(variant, effectiveHorizon),
    [variant, effectiveHorizon],
  );

  useEffect(() => { onLocationSelectRef.current = onLocationSelect; }, [onLocationSelect]);

  useEffect(() => {
    onFeatureSelectRef.current = onFeatureSelect;
  }, [onFeatureSelect]);

  useEffect(() => {
    if (horizon === undefined) setInternalHorizon(DEFAULT_HORIZONS[variant]);
    setInternalSelection(null);
  }, [variant, horizon]);

  const emitSelection = (selection: FloodMapSelection) => {
    setInternalSelection(selection);
    onFeatureSelectRef.current?.(selection);
  };

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    let disposed = false;
    let createdMap: MapLibreMap | null = null;
    setLoadState("loading");
    setMapEpoch(0);
    setFacilityRegion("chennai");
    setBasemapActive(Boolean(configuredBasemapTileUrl()));

    const initialize = async () => {
      try {
        const mapLibrary = await import("maplibre-gl");
        if (disposed) return;
        mapLibrary.setWorkerUrl(mapWorkerUrl);

        mapLibraryRef.current = mapLibrary;
        const view = initialViews[variant];
        const map = new mapLibrary.Map({
          container,
          style: createMapStyle(variant, effectiveHorizon, configuredBasemapTileUrl()),
          center: view.center,
          zoom: view.zoom,
          minZoom: onLocationSelectRef.current ? 5 : view.minZoom,
          maxZoom: view.maxZoom,
          maxBounds: onLocationSelectRef.current ? undefined : [[80.145, 12.875], [80.315, 13.075]],
          attributionControl: false,
          interactive,
          keyboard: interactive,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          cooperativeGestures: false,
          fadeDuration: 0,
          localIdeographFontFamily: false,
        });

        createdMap = map;
        mapRef.current = map;

        if (interactive) {
          map.addControl(new mapLibrary.NavigationControl({ showCompass: false }), "bottom-right");
          map.addControl(new mapLibrary.FullscreenControl({ container: container.parentElement ?? container }), "bottom-right");
          map.addControl(new mapLibrary.ScaleControl({ maxWidth: 90, unit: "metric" }), "bottom-left");
        }

        map.once("load", () => {
          if (disposed) return;
          setLoadState("ready");
          setMapEpoch((value) => value + 1);
          map.resize();
        });

        map.on("click", (event) => {
          if (onLocationSelectRef.current) {
            onLocationSelectRef.current([event.lngLat.wrap().lng, event.lngLat.lat]);
            return;
          }
          if (map.getLayer("osm-facilities") && map.queryRenderedFeatures(event.point, { layers: ["osm-facilities", "osm-facility-groups"] }).length) return;
          const layerIds = interactiveLayerIds.filter((layerId) => map.getLayer(layerId));
          const feature = map.queryRenderedFeatures(event.point, { layers: [...layerIds] })[0];
          if (!feature) return;
          const selection = renderedFeatureToSelection(feature);
          if (selection) emitSelection(selection);
        });

        map.on("mousemove", (event) => {
          if (!interactive) return;
          const layerIds = interactiveLayerIds.filter((layerId) => map.getLayer(layerId));
          const overFeature = map.queryRenderedFeatures(event.point, { layers: [...layerIds] }).length > 0;
          map.getCanvas().style.cursor = overFeature ? "pointer" : "";
        });

        map.on("error", (event) => {
          if ("sourceId" in event && event.sourceId === "basemap") {
            if (!map.getLayer("basemap")) return;
            map.removeLayer("basemap");
            map.removeSource("basemap");
            // Keep the packaged map and operational overlays usable if street tiles fail.
            for (const id of ["marsh-fill", "river-casing", "river-line", "road-casing", "road-line"]) {
              map.setLayoutProperty(id, "visibility", "visible");
            }
            map.setPaintProperty("ward-fill", "fill-opacity", 0.9);
            map.setPaintProperty("ward-line", "line-opacity", 0.82);
            map.setPaintProperty("current-flood-fill", "fill-opacity", 0.55);
            setBasemapActive(false);
            return;
          }
          if (!map.loaded() && event.error) setLoadState("error");
        });
      } catch {
        if (!disposed) setLoadState("error");
      }
    };

    void initialize();

    return () => {
      disposed = true;
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      if (createdMap) createdMap.remove();
      if (mapRef.current === createdMap) mapRef.current = null;
    };
    // The initial horizon is applied to the style; later changes use the dedicated layer update below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, interactive, selectingLocation]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || loadState !== "ready" || variant === "resilience") return;
    updateHorizonLayers(map, effectiveHorizon);
  }, [effectiveHorizon, loadState, variant]);

  useEffect(() => {
    const map = mapRef.current;
    const mapLibrary = mapLibraryRef.current;
    if (!map || !mapLibrary || loadState !== "ready") return;

    markersRef.current.forEach((marker) => marker.remove());
    const nextMarkers: MapLibreMarker[] = [];

    for (const feature of facilityRegion === "kerala" || selectingLocation ? [] : markerFeaturesForVariant(variant)) {
      const element = createMarkerElement(
        feature,
        variant,
        activeFeatureId === feature.properties.id,
        emitSelection,
      );
      const marker = new mapLibrary.Marker({
        element,
        anchor: feature.properties.kind === "hotspot" ? "bottom" : "center",
      })
        .setLngLat(feature.geometry.coordinates)
        .addTo(map);
      nextMarkers.push(marker);
    }

    if (facilityRegion === "chennai" && variant !== "field" && !basemapActive) {
      for (const feature of chennaiMapData.places.features) {
        const marker = new mapLibrary.Marker({ element: createPlaceLabel(feature), anchor: "center" })
          .setLngLat(feature.geometry.coordinates)
          .addTo(map);
        marker.getElement().setAttribute("role", "presentation");
        marker.getElement().setAttribute("aria-hidden", "true");
        marker.getElement().removeAttribute("tabindex");
        nextMarkers.push(marker);
      }
    }

    markersRef.current = nextMarkers;

    return () => {
      nextMarkers.forEach((marker) => marker.remove());
      if (markersRef.current === nextMarkers) markersRef.current = [];
    };
    // mapEpoch signals that the current style is fully loaded and can receive DOM markers.
  }, [activeFeatureId, basemapActive, facilityRegion, loadState, mapEpoch, selectingLocation, variant]);

  useEffect(() => {
    const map = mapRef.current;
    const library = mapLibraryRef.current;
    if (!map || !library || loadState !== "ready" || !selectedLocation) return;
    const marker = new library.Marker({ color: "#7629a8" }).setLngLat(selectedLocation).addTo(map);
    marker.getElement().setAttribute("aria-label", "Selected report location");
    map.jumpTo({ center: selectedLocation, zoom: Math.max(map.getZoom(), 14) });
    return () => { marker.remove(); };
  }, [selectedLocation?.[0], selectedLocation?.[1], loadState, mapEpoch]);

  useEffect(() => {
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => mapRef.current?.resize());
    if (mapContainerRef.current) observer?.observe(mapContainerRef.current);
    return () => observer?.disconnect();
  }, []);

  const changeHorizon = (nextHorizon: MapHorizon) => {
    if (horizon === undefined) setInternalHorizon(nextHorizon);
    onHorizonChange?.(nextHorizon);
  };

  const style = height === undefined
    ? undefined
    : ({ height: typeof height === "number" ? `${height}px` : height } as CSSProperties);

  return (
    <section
      className={`fr-flood-map fr-flood-map--${variant}${height === undefined ? "" : " fr-flood-map--explicit-height"}${className ? ` ${className}` : ""}`}
      style={style}
      aria-label={effectiveAriaLabel}
    >
      <p id={descriptionId} className="fr-map-sr-only" aria-live="polite">
        {facilityRegion === "kerala" ? "Kerala OpenStreetMap facilities. Geographic locations only; no flood estimates or verified shelter availability." : selectingLocation ? "Choose a report location on the map or edit coordinates in the form. Flood overlays are demo data." : screenReaderSummary}
        {facilityRegion === "chennai" && internalSelection
          ? ` Selected ${kindLabels[internalSelection.kind]}: ${internalSelection.name}. ${internalSelection.description ?? ""}`
          : ""}
      </p>

      <div className="fr-map-canvas-shell">
        <div
          ref={mapContainerRef}
          className="fr-map-canvas"
          role="region"
          aria-label={effectiveAriaLabel}
          aria-describedby={descriptionId}
        />

        <MarkerStatus state={loadState} />
        {interactive && !onLocationSelect && <Facilities key={`${variant}-${mapEpoch}`} allowRegionSwitch={allowRegionSwitch} map={loadState === "ready" ? mapRef.current : null} onRegionChange={(region) => { setFacilityRegion(region); onBaselineChange?.(region); }} />}

        {showDemoLabel && facilityRegion === "chennai" ? (
          <div className="fr-map-demo-label" role="note">
            DEMO DATA <span aria-hidden="true">•</span> NOT LIVE
          </div>
        ) : null}

        {showLegend && facilityRegion === "chennai" ? (
          <aside className="fr-map-legend" id={`${descriptionId}-legend`} aria-label="Map key">
            <div className="fr-map-legend__title">
              {variant === "resilience" ? "Audit key" : "Map key"}
            </div>
            <ul>
              {items.map((item) => (
                <li key={`${item.swatch}-${item.label}`}>
                  <span className={`fr-map-swatch fr-map-swatch--${item.swatch}`} aria-hidden="true" />
                  <span>{item.label}</span>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}

        {facilityRegion === "chennai" && variant !== "resilience" && showHorizonControl && (horizon === undefined || onHorizonChange) ? (
          <div className="fr-map-horizon" role="group" aria-label="Flood estimate horizon">
            {(["now", "1h", "3h"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={effectiveHorizon === value ? "is-active" : undefined}
                aria-pressed={effectiveHorizon === value}
                onClick={() => changeHorizon(value)}
              >
                {HORIZON_LABELS[value]}
              </button>
            ))}
          </div>
        ) : null}

        <div className={`fr-map-freshness${facilityRegion === "kerala" ? " fr-map-freshness--geography" : ""}`}>
          {facilityRegion === "kerala" ? "Kerala geography only · no flood estimates" : freshnessLabel ?? (variant === "resilience" ? "Audit compiled 18 Jul 2026" : "Scenario time 19:40 IST")}
        </div>

        <div className="fr-map-attribution" role="note">
          {basemapActive ? "Street map" : "Offline map"} ©{" "}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            OpenStreetMap contributors
          </a>{" "}
          · ODbL
        </div>
      </div>

      {showSummary && facilityRegion === "chennai" ? (
        <section className="fr-map-summary" aria-label="Synchronized map feature summary">
          <div className="fr-map-summary__intro">
            <strong>{variant === "resilience" ? "Priority summary" : "Map summary"}</strong>
            <span>{variant === "resilience" ? "Showing 6 of 18 hotspots" : HORIZON_DESCRIPTIONS[effectiveHorizon]}</span>
          </div>
          <ul>
            {summaryFeatures.map((feature) => (
              <li key={feature.properties.id}>
                <button
                  type="button"
                  className={activeFeatureId === feature.properties.id ? "is-selected" : undefined}
                  aria-pressed={activeFeatureId === feature.properties.id}
                  onClick={() => emitSelection(featureToSelection(feature))}
                >
                  <span className={`fr-map-summary__status fr-map-summary__status--${feature.properties.kind}`} aria-hidden="true" />
                  <span>
                    <strong>{feature.properties.name}</strong>
                    <small>{feature.properties.description}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
