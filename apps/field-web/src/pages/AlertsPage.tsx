import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle, Badge } from "@floodrise/ui";
import { BellRing, Clock3, Info, ShieldAlert, UsersRound } from "lucide-react";
import { fetchAlerts } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useNetworkStatus } from "../hooks/useNetworkStatus";
import { useI18n } from "../lib/i18n";

export function AlertsPage() {
  const { isOnline } = useNetworkStatus();
  const { t } = useI18n();
  const alerts = useQuery({ queryKey: ["field-alerts"], queryFn: fetchAlerts });

  return (
    <div className="page page-content standard-page">
      <div className="page-title-row">
        <div>
          <h1>{t("alerts.title")}</h1>
          <p>Cautions, authorized alerts, and system freshness updates for your selected area.</p>
        </div>
        <BellRing aria-hidden className="page-title-icon" />
      </div>

      {!isOnline ? (
        <Alert variant="warning">
          <AlertTitle>Showing last-known alerts</AlertTitle>
          <AlertDescription>New cautions cannot arrive while this device is offline.</AlertDescription>
        </Alert>
      ) : null}

      <div className="alert-list" aria-live="polite" aria-busy={alerts.isLoading}>
        {(alerts.data ?? []).map((item) => {
          const Icon = item.kind === "OFFICIAL" ? ShieldAlert : item.kind === "COMMUNITY_CAUTION" ? UsersRound : Info;
          return (
            <article key={item.id} className={`alert-item alert-${item.severity.toLowerCase()}`}>
              <div className="alert-item-icon"><Icon aria-hidden /></div>
              <div className="alert-item-body">
                <div className="alert-item-meta">
                  <Badge variant={item.kind === "OFFICIAL" ? "destructive" : item.kind === "COMMUNITY_CAUTION" ? "warning" : "secondary"}>
                    {item.kind === "OFFICIAL" ? "Official demo" : item.kind === "COMMUNITY_CAUTION" ? "Community caution" : "System"}
                  </Badge>
                  <span><Clock3 aria-hidden />{formatDateTime(item.issuedAt)}</span>
                </div>
                <h2>{item.title}</h2>
                <p>{item.description}</p>
                <footer>
                  <span>{item.area}</span>
                  <span>Valid until {formatDateTime(item.validUntil)}</span>
                </footer>
              </div>
            </article>
          );
        })}
      </div>

      <p className="page-footnote">
        DEMO DATA: No production alert gateway is contacted. Follow authorized local instructions during a real emergency.
      </p>
    </div>
  );
}
