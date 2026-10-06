import { Link, useRouterState } from "@tanstack/react-router";
import { Bell, CloudUpload, Map, Navigation, Plus } from "lucide-react";
import { useQueueSummary } from "../hooks/useQueueSummary";
import { useI18n } from "../lib/i18n";

const items = [
  { to: "/", labelKey: "nav.conditions", icon: Map },
  { to: "/report", labelKey: "nav.report", icon: Plus },
  { to: "/queue", labelKey: "nav.queue", icon: CloudUpload },
  { to: "/alerts", labelKey: "nav.alerts", icon: Bell },
  { to: "/lower-risk-route", labelKey: "nav.route", icon: Navigation }
] as const;

export function BottomNavigation() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const { count } = useQueueSummary();
  const { t } = useI18n();

  return (
    <nav className="bottom-navigation" aria-label={t("nav.label")}>
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.to === "/" ? path === "/" : path.startsWith(item.to);
        return (
          <Link key={item.to} to={item.to} className="bottom-navigation-item" data-active={active || undefined}>
            <span className="bottom-navigation-icon">
              <Icon aria-hidden />
              {item.to === "/queue" && count ? <span className="queue-count">{count > 99 ? "99+" : count}</span> : null}
            </span>
            <span>{t(item.labelKey)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
