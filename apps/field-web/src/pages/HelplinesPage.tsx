import { Alert, AlertDescription, AlertTitle } from "@floodrise/ui";
import { Phone, PhoneCall } from "lucide-react";
import { helplines } from "../data/helplines";
import { useI18n } from "../lib/i18n";

export function HelplinesPage() {
  const { t } = useI18n();

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
    </div>
  );
}
