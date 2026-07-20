import { useEffect, useState } from "react";
import { AppShell } from "./components/app-shell";
import type { ViewId } from "./lib/models";
import { OperationsProvider } from "./state/operations-context";
import { AuditView } from "./views/audit-view";
import { EvacuationView } from "./views/evacuation-view";
import { FloodSignalView } from "./views/flood-signal-view";
import { IncidentsView } from "./views/incidents-view";
import { LiveMapView } from "./views/live-map-view";
import { ResilienceView } from "./views/resilience-view";
import { SheltersView } from "./views/shelters-view";
import { SourceHealthView } from "./views/source-health-view";

const pathByView: Record<ViewId, string> = {
  live: "/",
  signals: "/signals",
  incidents: "/incidents",
  evacuation: "/evacuation",
  shelters: "/shelters",
  resilience: "/resilience",
  sources: "/sources",
  audit: "/audit",
};

function viewFromPath(pathname: string): ViewId {
  return (Object.entries(pathByView).find(([, path]) => path === pathname)?.[0] as ViewId | undefined) ?? "live";
}

function RoutedApp() {
  const [view, setView] = useState<ViewId>(() => viewFromPath(window.location.pathname));

  useEffect(() => {
    const handler = () => setView(viewFromPath(window.location.pathname));
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const navigate = (next: ViewId) => {
    window.history.pushState({}, "", pathByView[next]);
    setView(next);
  };

  const content = view === "live" ? <LiveMapView onNavigate={navigate} />
    : view === "signals" ? <FloodSignalView />
      : view === "incidents" ? <IncidentsView />
        : view === "evacuation" ? <EvacuationView />
          : view === "shelters" ? <SheltersView />
            : view === "resilience" ? <ResilienceView />
              : view === "sources" ? <SourceHealthView />
                : <AuditView />;

  return <AppShell view={view} onNavigate={navigate}>{content}</AppShell>;
}

export function App() {
  return <OperationsProvider><RoutedApp /></OperationsProvider>;
}
