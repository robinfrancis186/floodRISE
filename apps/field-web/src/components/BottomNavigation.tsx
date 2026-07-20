import { Link, useRouterState } from "@tanstack/react-router";
import { Bell, CloudUpload, Map, Navigation, Plus } from "lucide-react";
import { useQueueSummary } from "../hooks/useQueueSummary";

const items = [
  { to: "/", label: "Conditions", icon: Map },
  { to: "/report", label: "Report", icon: Plus },
  { to: "/queue", label: "Queue", icon: CloudUpload },
  { to: "/alerts", label: "Alerts", icon: Bell },
  { to: "/lower-risk-route", label: "Route", icon: Navigation }
] as const;

export function BottomNavigation() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const { count } = useQueueSummary();

  return (
    <nav className="bottom-navigation" aria-label="Field navigation">
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.to === "/" ? path === "/" : path.startsWith(item.to);
        return (
          <Link key={item.to} to={item.to} className="bottom-navigation-item" data-active={active || undefined}>
            <span className="bottom-navigation-icon">
              <Icon aria-hidden />
              {item.to === "/queue" && count ? <span className="queue-count">{count > 99 ? "99+" : count}</span> : null}
            </span>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
