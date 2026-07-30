import { useEffect, useState } from "react";
import { AppShell } from "./components/app-shell";
import { appPathForView, viewFromAppPath } from "./lib/app-paths";
import type { StaffRole, ViewId } from "./lib/models";
import {
  OperationsProvider,
  type OperationsMode,
} from "./state/operations-context";
import { AuditView } from "./views/audit-view";
import { EvacuationView } from "./views/evacuation-view";
import { FloodSignalView } from "./views/flood-signal-view";
import { IncidentsView } from "./views/incidents-view";
import { LiveMapView } from "./views/live-map-view";
import { ResilienceView } from "./views/resilience-view";
import { SheltersView } from "./views/shelters-view";
import { SourceHealthView } from "./views/source-health-view";

const appBase = import.meta.env.BASE_URL;

function RoutedApp() {
  const [view, setView] = useState<ViewId>(() => viewFromAppPath(window.location.pathname, appBase));

  useEffect(() => {
    const handler = () => setView(viewFromAppPath(window.location.pathname, appBase));
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const navigate = (next: ViewId) => {
    window.history.pushState({}, "", appPathForView(next, appBase));
    setView(next);
  };

  const content = view === "live" ? <LiveMapView onNavigate={navigate} />
    : view === "signals" ? <FloodSignalView />
      : view === "incidents" ? <IncidentsView onNavigate={navigate} />
        : view === "evacuation" ? <EvacuationView />
          : view === "shelters" ? <SheltersView />
            : view === "resilience" ? <ResilienceView />
              : view === "sources" ? <SourceHealthView />
                : <AuditView />;

  return <AppShell view={view} onNavigate={navigate}>{content}</AppShell>;
}

export function App({
  mode = "demo",
  initialRole = "Incident commander",
  principalUserId,
}: {
  mode?: OperationsMode;
  initialRole?: StaffRole;
  principalUserId?: string;
}) {
  return (
    <OperationsProvider
      mode={mode}
      initialRole={initialRole}
      principalUserId={principalUserId}
    >
      <RoutedApp />
    </OperationsProvider>
  );
}
