import { FloodRiseLogo } from "@floodrise/ui";
import { Cloud, CloudOff, Download, UserRound } from "lucide-react";
import { useInstallPrompt } from "../hooks/useInstallPrompt";
import { useNetworkStatus } from "../hooks/useNetworkStatus";
import { useFieldCloudAccess } from "../lib/cloud-access";

export function FieldHeader() {
  const { isOnline } = useNetworkStatus();
  const { runtime } = useFieldCloudAccess();
  const { canInstall, install } = useInstallPrompt();

  return (
    <>
      <header className="field-header">
        <div className="field-brand-row">
          <FloodRiseLogo />
          <span className="field-divider" aria-hidden />
          <span className="field-product-name">Field</span>
        </div>
        <div className="field-header-actions">
          {canInstall ? (
            <button className="header-action" type="button" onClick={() => void install()} aria-label="Install floodRISE Field">
              <Download aria-hidden />
              <span className="header-action-label">Install</span>
            </button>
          ) : null}
          <span className="network-state" aria-live="polite">
            {isOnline ? <Cloud aria-hidden /> : <CloudOff aria-hidden />}
            {isOnline ? "Online" : "Offline"}
          </span>
          <span
            className="field-avatar"
            role="img"
            aria-label={runtime.mode === "demo" ? "Guest field reporter" : "Field reporter session"}
          >
            <UserRound aria-hidden />
          </span>
        </div>
      </header>
      <NetworkStrip />
    </>
  );
}

function NetworkStrip() {
  const { isOnline } = useNetworkStatus();
  const lastSync = localStorage.getItem("floodrise.field.last-sync");
  const detail = lastSync ? "Last sync completed" : "Offline queue is ready";
  return (
    <div className={isOnline ? "network-strip network-strip-online" : "network-strip network-strip-offline"} role="status">
      <span className="network-dot" aria-hidden />
      <span>{isOnline ? "Connected" : "Offline-ready"}</span>
      <span aria-hidden>•</span>
      <span>{detail}</span>
    </div>
  );
}
