import { FloodMap } from "@floodrise/map";
import { Link } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle, Button } from "@floodrise/ui";
import { ArrowRight, Clock3, LocateFixed, Navigation, Plus, ShieldCheck } from "lucide-react";
import { fieldConditions } from "../data/demo";
import { StatusMark } from "../components/StatusMark";

export function CurrentConditionsPage() {
  return (
    <div className="page current-conditions-page">
      <section className="map-region" aria-labelledby="map-heading">
        <h1 id="map-heading" className="sr-only">Current flood conditions around Aluva</h1>
        <FloodMap
          variant="field"
          horizon="3h"
          height="clamp(320px, 47vh, 470px)"
          showSummary={false}
          cooperativeGestures
          ariaLabel="Current and estimated flood conditions near Aluva"
        />
        <div className="map-place-overlay">
          <LocateFixed aria-hidden />
          <div>
            <strong>Aluva, Kerala</strong>
            <span>Demo location · ±12 m</span>
          </div>
        </div>
      </section>

      <div className="page-content conditions-content">
        <div className="page-title-row conditions-title-row">
          <div>
            <h1>Current conditions</h1>
            <p>Observed information and rapid impact estimates are kept distinct.</p>
          </div>
        </div>

        <Alert variant="warning" className="community-caution">
          <ShieldCheck aria-hidden className="alert-leading-icon" />
          <div>
            <AlertTitle>Community-corroborated flooding nearby</AlertTitle>
            <AlertDescription>
              Corroborated by 4 independent recent reports; not an official confirmation.
            </AlertDescription>
          </div>
        </Alert>

        <div className="primary-actions">
          <Button asChild size="lg" className="primary-field-action">
            <Link to="/report"><Plus aria-hidden />Report flooding</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/lower-risk-route"><Navigation aria-hidden />Find a lower-risk route</Link>
          </Button>
        </div>

        <section aria-labelledby="nearby-heading" className="conditions-list-section">
          <div className="section-heading-row">
            <h2 id="nearby-heading">Nearby updates</h2>
            <span><Clock3 aria-hidden />As of 2 min ago</span>
          </div>
          <ul className="condition-list">
            {fieldConditions.map((condition) => (
              <li key={condition.id}>
                <div className="condition-row-heading">
                  <StatusMark status={condition.status} />
                  <span>{condition.age}</span>
                </div>
                <strong>{condition.title}</strong>
                <p>{condition.detail}</p>
              </li>
            ))}
          </ul>
        </section>

        <Link className="text-link-row" to="/alerts">
          View all cautions and alerts <ArrowRight aria-hidden />
        </Link>
      </div>
    </div>
  );
}
