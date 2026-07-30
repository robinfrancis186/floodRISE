import { FloodMap } from "@floodrise/map";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle, Badge, Button } from "@floodrise/ui";
import { CheckCircle2, Clock3, MapPin, Navigation, Route, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { fetchRoutes } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useNetworkStatus } from "../hooks/useNetworkStatus";
import {
  isLiveEligibleLocationAccuracy,
  MAX_LIVE_LOCATION_ACCURACY_M
} from "../lib/location-policy";
import { useFieldCloudAccess } from "../lib/cloud-access";

export function LowerRiskRoutePage() {
  const { isOnline } = useNetworkStatus();
  const { runtime } = useFieldCloudAccess();
  const isDemo = runtime.mode === "demo";
  const queryClient = useQueryClient();
  const [origin, setOrigin] = useState<{
    latitude: number;
    longitude: number;
    accuracy_m: number;
    label: string;
  } | null>(() => isDemo ? {
    latitude: 10.1041000,
    longitude: 76.3519000,
    accuracy_m: 12,
    label: "Aluva–Paravur Road"
  } : null);
  const [locating, setLocating] = useState(false);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const originIsEligible = origin
    ? isLiveEligibleLocationAccuracy(origin.accuracy_m)
    : false;
  const routes = useQuery({
    queryKey: [
      "field-routes",
      runtime.incidentId,
      origin?.latitude,
      origin?.longitude,
      origin?.accuracy_m,
    ],
    queryFn: () => fetchRoutes(origin!, runtime),
    enabled: Boolean(isOnline && runtime.incidentId && origin && originIsEligible)
  });
  const guidanceAvailable = originIsEligible && routes.data?.availability === "CURRENT";
  const selectedRoute = guidanceAvailable
    ? routes.data?.alternatives.find((route) => route.id === selectedRouteId) ?? null
    : null;

  function useCurrentOrigin() {
    if (!navigator.geolocation || !isOnline) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        queryClient.removeQueries({ queryKey: ["field-routes"] });
        setSelectedRouteId(null);
        setOrigin({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy_m: position.coords.accuracy,
          label: "Current device location"
        });
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 8_000, maximumAge: 30_000 }
    );
  }

  return (
    <div className="page route-page">
      <section className="map-region compact-map-region">
        {originIsEligible && isDemo ? (
          <FloodMap
            variant="field"
            horizon="now"
            height="clamp(260px, 37vh, 370px)"
            showSummary={false}
            interactive={false}
            showRouteGeometry={false}
            ariaLabel="Non-navigational demo context map showing flood estimates, road risk, and nearby shelters; route geometry is not shown"
          />
        ) : originIsEligible ? (
          <div className="route-map-paused field-live-map-boundary" role="status">
            <MapPin aria-hidden />
            <strong>Live route map is unavailable</strong>
            <span>
              The current device origin is ready, but the authority response does not include field-safe route geometry.
              No deterministic Kerala map is substituted.
            </span>
          </div>
        ) : (
          <div className="route-map-paused" role="status">
            <MapPin aria-hidden />
            <strong>Route map paused</strong>
            <span>
              {origin
                ? "Improve the device location fix before showing flood and shelter context."
                : "Use the current device location before requesting route guidance."}
            </span>
          </div>
        )}
        {originIsEligible && isDemo ? (
          <div className="route-map-context-note" role="note" aria-label="Route map safety boundary">
            <Route aria-hidden />
            <span><strong>Context only</strong>Route geometry is not provided by the recommendation API and is not shown.</span>
          </div>
        ) : null}
      </section>
      <div className="page-content route-content">
        <div className="page-title-row">
          <div>
            <h1>Lower-risk route</h1>
            <p>Route estimates combine current evidence, predicted flooding, closures, and shelter status.</p>
          </div>
          <Navigation aria-hidden className="page-title-icon" />
        </div>

        {!isOnline ? (
          <Alert variant="destructive" className="offline-route-alert">
            <ShieldAlert aria-hidden className="alert-leading-icon" />
            <div>
              <AlertTitle>Fresh route guidance unavailable offline</AlertTitle>
              <AlertDescription>
                Reconnect before requesting a route. Previously viewed routes may be stale and must not be treated as safe.
              </AlertDescription>
            </div>
          </Alert>
        ) : null}

        {isOnline && routes.data?.availability === "UNAVAILABLE" ? (
          <Alert variant="destructive" className="offline-route-alert">
            <ShieldAlert aria-hidden className="alert-leading-icon" />
            <div>
              <AlertTitle>Fresh route guidance unavailable</AlertTitle>
              <AlertDescription>{routes.data.message}</AlertDescription>
            </div>
          </Alert>
        ) : null}

        {isOnline && origin && !originIsEligible ? (
          <Alert variant="warning" className="location-policy-alert">
            <ShieldAlert aria-hidden className="alert-leading-icon" />
            <div>
              <AlertTitle>Location accuracy is too low for route guidance</AlertTitle>
              <AlertDescription>
                The current ±{Math.round(origin.accuracy_m)} m fix is preserved. Route guidance requires{" "}
                {MAX_LIVE_LOCATION_ACCURACY_M} m or better; move to an open area and try again.
              </AlertDescription>
            </div>
          </Alert>
        ) : null}

        {isOnline && !origin ? (
          <Alert variant="info" className="location-policy-alert">
            <MapPin aria-hidden className="alert-leading-icon" />
            <div>
              <AlertTitle>Choose a live starting location</AlertTitle>
              <AlertDescription>
                Live mode never selects a demo origin. Use the current device location to request guidance.
              </AlertDescription>
            </div>
          </Alert>
        ) : null}

        <div className="route-origin-row">
          <MapPin aria-hidden />
          <div><span>Starting near</span><strong>{origin?.label ?? "Location not selected"}</strong></div>
          <Button variant="link" type="button" disabled={!isOnline || locating} onClick={useCurrentOrigin}>
            {locating ? "Locating…" : isDemo ? "Use current" : origin ? "Update location" : "Use current"}
          </Button>
        </div>

        {isOnline && originIsEligible && routes.isLoading ? (
          <div className="route-disabled-state" role="status">
            <Navigation aria-hidden />
            <strong>Checking route freshness…</strong>
            <span>Verifying model, evidence, closure, and shelter versions.</span>
          </div>
        ) : isOnline && guidanceAvailable ? (
          <section aria-labelledby="route-options-heading">
            <div className="section-heading-row">
              <h2 id="route-options-heading">Route options</h2>
              <span><Clock3 aria-hidden />{isDemo ? "Demo estimate" : "Current estimate"}</span>
            </div>
            <div className="route-list" aria-busy={routes.isLoading}>
              {(routes.data?.alternatives ?? []).map((route, index) => {
                const isSelected = route.id === selectedRouteId;
                return (
                  <article className="route-option" key={route.id} data-selected={isSelected || undefined}>
                    <div className="route-option-head">
                      <span className="route-number"><Route aria-hidden />{index + 1}</span>
                      <Badge variant={route.risk === "LOWER" ? "success" : "warning"}>
                        {route.risk === "LOWER" ? "Lower risk" : "Elevated uncertainty"}
                      </Badge>
                    </div>
                    <h3>{route.label}</h3>
                    <p className="route-destination">To {route.shelter}</p>
                    <div className="route-metrics">
                      <strong>{route.duration_min} min</strong><span>{route.distance_km.toFixed(1)} km</span>
                    </div>
                    <ul>{route.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                    <p className="route-validity">Estimate valid until {formatDateTime(route.valid_until)}</p>
                    <Button
                      type="button"
                      variant={isSelected ? "default" : "outline"}
                      className="route-action"
                      aria-label={`Review ${route.label} to ${route.shelter}`}
                      aria-pressed={isSelected}
                      onClick={() => setSelectedRouteId((current) => current === route.id ? null : route.id)}
                    >
                      {isSelected ? <CheckCircle2 aria-hidden /> : null}
                      {isSelected ? "Selected for review" : "Review this route"}
                    </Button>
                  </article>
                );
              })}
            </div>
            {selectedRoute ? (
              <section
                className="route-review-panel"
                role="status"
                aria-label="Selected route details"
                aria-live="polite"
                aria-atomic="true"
              >
                <CheckCircle2 aria-hidden />
                <div>
                  <span className="route-review-kicker">Selected for review</span>
                  <h3>{selectedRoute.label}</h3>
                  <p className="route-review-summary">
                    {selectedRoute.duration_min} min · {selectedRoute.distance_km.toFixed(1)} km to{" "}
                    {selectedRoute.shelter}
                  </p>
                  <dl className="route-review-versions">
                    <div><dt>Valid until</dt><dd>{formatDateTime(selectedRoute.valid_until)}</dd></div>
                    <div><dt>Model</dt><dd>{selectedRoute.model_version}</dd></div>
                    <div><dt>Evidence</dt><dd>{selectedRoute.evidence_version}</dd></div>
                  </dl>
                  <p className="route-review-boundary">
                    Review only. This does not start navigation or guarantee that the route is safe.
                  </p>
                </div>
              </section>
            ) : null}
          </section>
        ) : (
          <div className="route-disabled-state" aria-disabled="true">
            <Navigation aria-hidden />
            <strong>Route options paused</strong>
            <span>{isOnline ? "Await fresh model and evidence versions or responder guidance." : "Reconnect to calculate from fresh model and evidence versions."}</span>
          </div>
        )}

        <p className="safety-disclaimer">
          A lower-risk route is not guaranteed safe. Never enter moving water or bypass an authorized closure.
        </p>
      </div>
    </div>
  );
}
