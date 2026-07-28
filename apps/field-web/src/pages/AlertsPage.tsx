import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle, Badge } from "@floodrise/ui";
import { BellOff, BellRing, Clock3, Info, ShieldAlert, UsersRound } from "lucide-react";
import { fetchAlerts } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useNetworkStatus } from "../hooks/useNetworkStatus";

export function AlertsPage() {
  const { isOnline } = useNetworkStatus();
  const alerts = useQuery({ queryKey: ["field-alerts"], queryFn: fetchAlerts });

  return (
    <div className="page page-content standard-page">
      <div className="page-title-row">
        <div>
          <h1>Alerts</h1>
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

      {alerts.data?.source === "DEMO_FALLBACK" ? (
        <Alert variant="warning" className="alert-source-warning" role="alert">
          <ShieldAlert aria-hidden className="alert-leading-icon" />
          <div>
            <AlertTitle>Alert API unavailable</AlertTitle>
            <AlertDescription>{alerts.data.message}</AlertDescription>
          </div>
        </Alert>
      ) : null}

      <div className="alert-list" aria-live="polite" aria-busy={alerts.isLoading}>
        {(alerts.data?.items ?? []).map((item) => {
          const Icon = item.kind === "OFFICIAL" ? ShieldAlert : item.kind === "COMMUNITY_CAUTION" ? UsersRound : Info;
          return (
            <article key={item.id} className={`alert-item alert-${item.severity.toLowerCase()}`}>
              <div className="alert-item-icon"><Icon aria-hidden /></div>
              <div className="alert-item-body">
                <div className="alert-item-meta">
                  <Badge variant={item.kind === "OFFICIAL" ? "destructive" : item.kind === "COMMUNITY_CAUTION" ? "warning" : "secondary"}>
                    {item.kind === "OFFICIAL"
                      ? item.isSimulated ? "Official demo" : "Official"
                      : item.kind === "COMMUNITY_CAUTION" ? "Community caution" : "System"}
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
        {!alerts.isLoading && (alerts.data?.items.length ?? 0) === 0 ? (
          <div className="alerts-empty-state" role="status">
            <BellOff aria-hidden />
            <strong>No current alerts for the demo scenario time</strong>
            <span>Expired and not-yet-issued messages are withheld. Continue to monitor conditions.</span>
          </div>
        ) : null}
      </div>

      <p className="page-footnote">
        DEMO DATA: No production alert gateway is contacted. Follow authorized local instructions during a real emergency.
      </p>
    </div>
  );
}
