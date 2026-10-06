import { FloodRiseLogo } from "@floodrise/ui";
import { Link } from "@tanstack/react-router";
import { Cloud, CloudOff, Download, PhoneCall, UserRound } from "lucide-react";
import { useInstallPrompt } from "../hooks/useInstallPrompt";
import { useNetworkStatus } from "../hooks/useNetworkStatus";
import { LANGUAGES, useI18n, type Language } from "../lib/i18n";

export function FieldHeader() {
  const { isOnline } = useNetworkStatus();
  const { canInstall, install } = useInstallPrompt();
  const { t } = useI18n();

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
            <button className="header-action" type="button" onClick={() => void install()} aria-label={t("header.installLabel")}>
              <Download aria-hidden />
              <span className="header-action-label">{t("header.install")}</span>
            </button>
          ) : null}
          <Link className="header-action header-sos" to="/helplines" aria-label={t("header.helplines")}>
            <PhoneCall aria-hidden />
            <span dir="ltr">{t("header.sos")}</span>
          </Link>
          <span className="network-state" aria-live="polite">
            {isOnline ? <Cloud aria-hidden /> : <CloudOff aria-hidden />}
            {isOnline ? t("net.online") : t("net.offline")}
          </span>
          <span className="field-avatar" role="img" aria-label="Guest field reporter">
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
  const { language, setLanguage, t } = useI18n();
  const detail = lastSync ? t("net.lastSync") : t("net.queueReady");
  return (
    <div className={isOnline ? "network-strip network-strip-online" : "network-strip network-strip-offline"}>
      <div className="network-strip-status" role="status">
        <span className="network-dot" aria-hidden />
        <span>{isOnline ? t("net.connected") : t("net.offlineReady")}</span>
        <span aria-hidden>•</span>
        <span>{detail}</span>
      </div>
      <select
        className="language-select"
        aria-label={t("header.language")}
        value={language}
        onChange={(event) => setLanguage(event.target.value as Language)}
      >
        {LANGUAGES.map((item) => (
          <option key={item.code} value={item.code} lang={item.code}>{item.name}</option>
        ))}
      </select>
    </div>
  );
}
