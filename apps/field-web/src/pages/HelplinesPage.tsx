import { facilityBaseline, facilityDistance, findMapFacilities } from "@floodrise/map/facilities";
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

  const origin: [number, number] = [80.2209, 12.9791];
  const facilities = hospitals.data ?? {
    items: findMapFacilities(["HOSPITAL"], "", origin).slice(0, 5).map((feature) => ({
      id: feature.id, name: feature.properties.name,
      names: Object.fromEntries(["en", "ta", "hi", "ml"].flatMap((lang) => typeof feature.properties[`name_${lang}`] === "string" ? [[lang, feature.properties[`name_${lang}`] as string]] : [])),
      location: { latitude: feature.geometry.coordinates[1], longitude: feature.geometry.coordinates[0] },
      distance_m: facilityDistance(feature, origin)
    })),
    attribution: facilityBaseline.attribution
  };

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

      <section aria-labelledby="facilities-heading" aria-busy={false}>
        <h2 id="facilities-heading" className="facility-heading">{t("facilities.title")}</h2>
        <p className="page-footnote">{t("facilities.note")}</p>
        <p className="page-footnote">Distances from the Chennai demo pin, not your current location. {hospitals.data ? "API baseline" : `Packaged OSM snapshot ${facilityBaseline.source_snapshot_at.slice(0, 10)}`}. Straight-line distance; no route or opening status verified.</p>
        <>
            <ul className="facility-list">
              {facilities.items.map((facility) => (
                <li key={facility.id}>
                  <span className="facility-text">
                    <strong>{facility.names[language] ?? facility.name}</strong>
                    {facility.distance_m === null ? null : <span>{formatDistance(facility.distance_m)}</span>}
                  </span>
                  <a
                    className="facility-map-link"
                    href={`https://www.openstreetmap.org/#map=18/${facility.location.latitude}/${facility.location.longitude}`}
                    target="_blank" rel="noreferrer"
                    aria-label={`${t("facilities.map")}: ${facility.names[language] ?? facility.name}`}
                  >
                    <MapPin aria-hidden />
                    {t("facilities.map")}
                  </a>
                </li>
              ))}
            </ul>
            <p className="page-footnote">{facilities.attribution}</p>
        </>
      </section>
    </div>
  );
}
