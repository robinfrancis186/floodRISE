import { Outlet, useRouterState } from "@tanstack/react-router";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  DemoBanner,
} from "@floodrise/ui";
import { CloudOff, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { BottomNavigation } from "./components/BottomNavigation";
import { FieldHeader } from "./components/FieldHeader";
import { useAutoSync } from "./hooks/useAutoSync";
import { useFieldCloudAccess } from "./lib/cloud-access";

export function AppShell() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const {
    browserOnline,
    isOfflineOnly,
    isOnline,
    isSyncing,
    lastResult,
  } = useAutoSync();
  const cloudAccess = useFieldCloudAccess();
  const isFocusedPage = path === "/report" || path === "/demo-reset";

  useEffect(() => {
    document.documentElement.dataset.network = isOnline ? "online" : "offline";
  }, [isOnline]);

  return (
    <div className="field-app">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      {cloudAccess.runtime.mode === "demo" ? <DemoBanner /> : null}
      <FieldHeader />
      {isOfflineOnly && cloudAccess.mode === "offline_only" ? (
        <Alert
          className="offline-access-notice"
          role="status"
          aria-live="polite"
        >
          <CloudOff aria-hidden className="alert-leading-icon" />
          <div>
            <AlertTitle>Offline draft review is available</AlertTitle>
            <AlertDescription>
              You can review existing encrypted drafts. Creating or syncing a
              report, receiving new alerts, and requesting lower-risk routes
              stay paused until the authority incident is verified.
            </AlertDescription>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!browserOnline}
              onClick={cloudAccess.retry}
            >
              <RefreshCw aria-hidden />
              {browserOnline ? "Verify secure access" : "Reconnect to verify"}
            </Button>
          </div>
        </Alert>
      ) : null}
      {lastResult?.synced ? (
        <div className="sync-announcement" role="status">
          {lastResult.synced} queued {lastResult.synced === 1 ? "report" : "reports"} synced.
        </div>
      ) : null}
      {isSyncing ? <span className="sr-only" role="status">Syncing queued reports</span> : null}
      <main id="main-content" tabIndex={-1} className={isFocusedPage ? "field-main report-main" : "field-main"}>
        <Outlet />
      </main>
      {!isFocusedPage ? <BottomNavigation /> : null}
    </div>
  );
}
