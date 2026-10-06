import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@floodrise/ui";
import { MapPin, Phone, PhoneCall } from "lucide-react";
import { helplines } from "../data/helplines";
import { fetchNearbyHospitals } from "../lib/api";
import { formatDistance } from "../lib/format";
import { useI18n } from "../lib/i18n";

export function HelplinesPage() {
  const { t, language } = useI18n();
  const hospitals = useQuery({ queryKey: ["nearby-hospitals"], queryFn: () => fetchNearbyHospitals() });

  return (
    <div className="page page-content standard-page">
      <div className="page-title-row">
        <div>
          <h1>{t("helplines.title")}</h1>
          <p>{t("helplines.intro")}</p>
        </div>
        <PhoneCall aria-hidden className="page-title-icon" />
      </div>

      <Alert variant="warning">
        <AlertTitle>{t("helplines.safety")}</AlertTitle>
        <AlertDescription>{t("helplines.verify")}</AlertDescription>
      </Alert>

      <ul className="helpline-list">
        {helplines.map((helpline) => (
          <li key={helpline.id}>
            <a className="helpline-link" href={`tel:${helpline.number}`}>
              <span className="helpline-text">
                <strong dir="ltr">{helpline.number}</strong>
                <span>{t(helpline.labelKey)}</span>
              </span>
              <span className="helpline-call">
                <Phone aria-hidden />
                {t("helplines.call")}
              </span>
            </a>
          </li>
        ))}
      </ul>

      <section aria-labelledby="facilities-heading" aria-busy={hospitals.isLoading}>
        <h2 id="facilities-heading" className="facility-heading">{t("facilities.title")}</h2>
        <p className="page-footnote">{t("facilities.note")}</p>
        {hospitals.data ? (
          <>
            <ul className="facility-list">
              {hospitals.data.items.map((facility) => (
                <li key={facility.id}>
                  <span className="facility-text">
                    <strong>{facility.names[language] ?? facility.name}</strong>
                    {facility.distance_m === null ? null : <span>{formatDistance(facility.distance_m)}</span>}
                  </span>
                  <a
                    className="facility-map-link"
                    href={`geo:${facility.location.latitude},${facility.location.longitude}`}
                    aria-label={`${t("facilities.map")}: ${facility.names[language] ?? facility.name}`}
                  >
                    <MapPin aria-hidden />
                    {t("facilities.map")}
                  </a>
                </li>
              ))}
            </ul>
            <p className="page-footnote">{hospitals.data.attribution}</p>
          </>
        ) : hospitals.isLoading ? null : (
          <p className="page-footnote" role="status">{t("facilities.unavailable")}</p>
        )}
      </section>
    </div>
  );
}
