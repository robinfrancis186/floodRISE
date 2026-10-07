import { useState } from "react";
import { FloodMap } from "@floodrise/map";
import { Link } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle, Badge, Button } from "@floodrise/ui";
import { ArrowRight, Clock3, LocateFixed, Navigation, Plus, ShieldCheck } from "lucide-react";
import { fieldConditions } from "../data/demo";
import { useNetworkStatus } from "../hooks/useNetworkStatus";
import { useI18n } from "../lib/i18n";
import { StatusMark } from "../components/StatusMark";

export function CurrentConditionsPage() {
  const { isOnline } = useNetworkStatus();
  const { t } = useI18n();
  const [baseline, setBaseline] = useState<"chennai" | "kerala">("chennai");

  return (
    <div className="page current-conditions-page">
      <section className="map-region" aria-labelledby="map-heading">
        <h1 id="map-heading" className="sr-only">{baseline === "kerala" ? "Kerala facility locations" : "Current flood conditions around Velachery"}</h1>
        <FloodMap
          variant="field"
          allowRegionSwitch
          onBaselineChange={setBaseline}
          horizon="3h"
          height="clamp(320px, 47vh, 470px)"
          showSummary={false}
          ariaLabel="Current and estimated flood conditions near Velachery"
        />
        {baseline === "chennai" && <div className="map-place-overlay">
          <LocateFixed aria-hidden />
          <div>
            <strong>Velachery, Chennai</strong>
            <span>Demo location · ±12 m</span>
          </div>
        </div>}
      </section>

      {baseline === "chennai" ? <div className="page-content conditions-content">
        <div className="page-title-row">
          <div>
            <h1>{t("conditions.title")}</h1>
            <p>Observed information and rapid impact estimates are kept distinct.</p>
          </div>
          <Badge variant={isOnline ? "success" : "warning"}>{isOnline ? "Connected" : "Last known"}</Badge>
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
            <Link to="/report"><Plus aria-hidden />{t("conditions.report")}</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/lower-risk-route"><Navigation aria-hidden />{t("conditions.route")}</Link>
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
      </div> : <div className="page-content conditions-content"><h1>Kerala mapped places</h1><p>Search hospitals, police, fire stations, and community facilities using Places on the map. Opening status and access are unverified.</p><Alert variant="warning"><AlertTitle>Geographic baseline only</AlertTitle><AlertDescription>No Kerala flood estimates, activated shelters, or verified routes are available. Reporting and alerts still use the Chennai demo incident.</AlertDescription></Alert></div>}
    </div>
  );
}
