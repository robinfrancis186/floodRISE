import { Outlet, useRouterState } from "@tanstack/react-router";
import { DemoBanner } from "@floodrise/ui";
import { useEffect } from "react";
import { BottomNavigation } from "./components/BottomNavigation";
import { FieldHeader } from "./components/FieldHeader";
import { useAutoSync } from "./hooks/useAutoSync";

export function AppShell() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const { isOnline, isSyncing, lastResult } = useAutoSync();
  const isFocusedPage = path === "/report" || path === "/demo-reset";

  useEffect(() => {
    document.documentElement.dataset.network = isOnline ? "online" : "offline";
  }, [isOnline]);

  return (
    <div className="field-app">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <DemoBanner />
      <FieldHeader />
      {lastResult?.synced ? (
        <div className="sync-announcement" role="status">
          {lastResult.synced} queued {lastResult.synced === 1 ? "report" : "reports"} synced.
        </div>
      ) : null}
      {isSyncing ? <span className="sr-only" role="status">Syncing queued reports</span> : null}
      <main id="main-content" className={isFocusedPage ? "field-main report-main" : "field-main"}>
        <Outlet />
      </main>
      {!isFocusedPage ? <BottomNavigation /> : null}
    </div>
  );
}
