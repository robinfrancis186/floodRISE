import { lazy, Suspense, useEffect, useState } from "react";
import { viewConfig, AppShell } from "./components/app-shell";
import type { ViewId } from "./lib/models";
import { OperationsProvider } from "./state/operations-context";
const AuditView = lazy(() => import("./views/audit-view").then((module) => ({ default: module.AuditView })));
const EvacuationView = lazy(() => import("./views/evacuation-view").then((module) => ({ default: module.EvacuationView })));
const FloodSignalView = lazy(() => import("./views/flood-signal-view").then((module) => ({ default: module.FloodSignalView })));
const IncidentsView = lazy(() => import("./views/incidents-view").then((module) => ({ default: module.IncidentsView })));
import { LiveMapView } from "./views/live-map-view";
const ResilienceView = lazy(() => import("./views/resilience-view").then((module) => ({ default: module.ResilienceView })));
const SheltersView = lazy(() => import("./views/shelters-view").then((module) => ({ default: module.SheltersView })));
const SourceHealthView = lazy(() => import("./views/source-health-view").then((module) => ({ default: module.SourceHealthView })));

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

  useEffect(() => { document.title = `floodRISE Operations · ${viewConfig[view].title}`; }, [view]);

  const navigate = (next: ViewId) => {
    if (next === view) return;
    window.history.pushState({}, "", pathByView[next]);
    setView(next);
  };

  const content = view === "live" ? <LiveMapView onNavigate={navigate} />
    : view === "signals" ? <FloodSignalView />
      : view === "incidents" ? <IncidentsView onNavigate={navigate} />
      : view === "evacuation" ? <EvacuationView onNavigate={navigate} />
          : view === "shelters" ? <SheltersView />
            : view === "resilience" ? <ResilienceView />
              : view === "sources" ? <SourceHealthView />
                : <AuditView />;

  return <AppShell view={view} onNavigate={navigate}><Suspense fallback={<div className="fr-recovery" role="status">Loading view…</div>}>{content}</Suspense></AppShell>;
}

export function App() {
  return <OperationsProvider><RoutedApp /></OperationsProvider>;
}
