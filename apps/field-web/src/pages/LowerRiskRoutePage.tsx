import { FloodMap } from "@floodrise/map";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle, Badge, Button } from "@floodrise/ui";
import { Clock3, MapPin, Navigation, Route, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { fetchRoutes } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useNetworkStatus } from "../hooks/useNetworkStatus";

export function LowerRiskRoutePage() {
  const { isOnline } = useNetworkStatus();
  const [origin, setOrigin] = useState({
    latitude: 12.9791,
    longitude: 80.2209,
    accuracy_m: 12,
    label: "Velachery Main Road"
  });
  const [locating, setLocating] = useState(false);
  const routes = useQuery({
    queryKey: ["field-routes", origin.latitude, origin.longitude],
    queryFn: () => fetchRoutes(origin),
    enabled: isOnline
  });
  const guidanceAvailable = routes.data?.availability === "CURRENT";

  function useCurrentOrigin() {
    if (!navigator.geolocation || !isOnline) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setOrigin({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy_m: Math.min(100, Math.round(position.coords.accuracy)),
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
        <FloodMap
          variant="field"
          horizon="now"
          height="clamp(260px, 37vh, 370px)"
          showSummary={false}
          interactive={isOnline}
          ariaLabel="Map of lower-risk route alternatives to nearby shelters"
        />
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

        <div className="route-origin-row">
          <MapPin aria-hidden />
          <div><span>Starting near</span><strong>{origin.label}</strong></div>
          <Button variant="link" type="button" disabled={!isOnline || locating} onClick={useCurrentOrigin}>
            {locating ? "Locating…" : "Use current"}
          </Button>
        </div>

        {isOnline && routes.isLoading ? (
          <div className="route-disabled-state" role="status">
            <Navigation aria-hidden />
            <strong>Checking route freshness…</strong>
            <span>Verifying model, evidence, closure, and shelter versions.</span>
          </div>
        ) : isOnline && guidanceAvailable ? (
          <section aria-labelledby="route-options-heading">
            <div className="section-heading-row">
              <h2 id="route-options-heading">Route options</h2>
              <span><Clock3 aria-hidden />Demo estimate</span>
            </div>
            <div className="route-list" aria-busy={routes.isLoading}>
              {(routes.data?.alternatives ?? []).map((route, index) => (
                <article className="route-option" key={route.id} data-selected={index === 0 || undefined}>
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
                  <Button type="button" variant={index === 0 ? "default" : "outline"} className="route-action">
                    Review this route
                  </Button>
                </article>
              ))}
            </div>
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
