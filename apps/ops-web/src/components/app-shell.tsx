import { Button, DemoBanner, FloodRiseLogo, Select } from "@floodrise/ui";
import {
  AlertTriangle,
  Bell,
  Building2,
  CheckCircle2,
  ClipboardList,
  CloudRain,
  DatabaseZap,
  FileClock,
  Gauge,
  HeartHandshake,
  History,
  Map,
  Navigation,
  RadioTower,
  RefreshCcw,
  RotateCcw,
  Search,
  ShieldCheck,
  Waves,
} from "lucide-react";
import type { ReactNode } from "react";
import type { StaffRole, ViewId } from "../lib/models";
import { useOperations } from "../state/operations-context";

export const viewConfig: Record<ViewId, { label: string; shortLabel: string; title: string; icon: typeof Map }> = {
  live: { label: "Live Map", shortLabel: "Map", title: "Live Operations", icon: Map },
  signals: { label: "FloodSignal", shortLabel: "Signals", title: "FloodSignal Review", icon: RadioTower },
  incidents: { label: "Incidents", shortLabel: "Incidents", title: "Incident Management", icon: AlertTriangle },
  evacuation: { label: "Evacuation", shortLabel: "Routes", title: "Evacuation Routing", icon: Navigation },
  shelters: { label: "Shelters", shortLabel: "Shelters", title: "Shelter Operations", icon: Building2 },
  resilience: { label: "Resilience Audit", shortLabel: "Resilience", title: "Resilience Audit", icon: ShieldCheck },
  sources: { label: "Source Health", shortLabel: "Sources", title: "Source Health", icon: DatabaseZap },
  audit: { label: "Audit Log", shortLabel: "Audit", title: "Audit Log", icon: FileClock },
};

const roles: StaffRole[] = ["Incident commander", "Verifier", "Field responder", "Resilience engineer", "Shelter manager", "Auditor", "Identity administrator"];

export function AppShell({ view, onNavigate, children }: { view: ViewId; onNavigate: (view: ViewId) => void; children: ReactNode }) {
  const { snapshot, connected, streamStatus, role, setRole, advanceDemo, resetDemo, notice } = useOperations();
  const time = new Date(snapshot.scenarioTime).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
  const liveUpdatesConnected = connected && streamStatus === "live";
  const syncLabel = !connected
    ? "Local deterministic mode"
    : streamStatus === "live"
      ? "API synced"
      : streamStatus === "connecting"
        ? "API connected · live updates connecting"
        : streamStatus === "reconnecting"
          ? "API connected · live updates reconnecting"
          : "API connected · live updates unavailable";
  return (
    <div className="app-frame">
      <DemoBanner />
      <header className="topbar">
        <div className="topbar-brand"><FloodRiseLogo /><span className="topbar-divider" aria-hidden /><h1>{viewConfig[view].title}</h1></div>
        <button className="incident-select" type="button" aria-label="Selected incident: Ernakulam Kerala extreme-rainfall replay">
          Ernakulam <span aria-hidden>•</span> Kerala extreme-rainfall <span aria-hidden>⌄</span>
        </button>
        <div className="topbar-sync" aria-live="polite">
          <span>Scenario {time} IST</span><span className={liveUpdatesConnected ? "sync-dot connected" : "sync-dot"} aria-hidden />
          <span>{syncLabel}</span>
        </div>
        <label className="global-search">
          <Search aria-hidden />
          <span className="sr-only">Search locations, assets, or identifiers</span>
          <input type="search" placeholder="Search locations, assets, IDs…" />
        </label>
        <Button className="notification-button" variant="ghost" size="icon" aria-label="7 unread notifications"><Bell /><span>7</span></Button>
        <label className="role-select">
          <span className="sr-only">Active role</span>
          <Select value={role} onChange={(event) => setRole(event.target.value as StaffRole)}>{roles.map((item) => <option key={item}>{item}</option>)}</Select>
        </label>
      </header>

      <aside className="sidebar" aria-label="Primary navigation">
        <nav>
          {(Object.entries(viewConfig) as [ViewId, typeof viewConfig[ViewId]][]).map(([id, item]) => {
            const Icon = item.icon;
            return <button key={id} className="nav-item" data-active={view === id || undefined} onClick={() => onNavigate(id)} aria-current={view === id ? "page" : undefined}><Icon aria-hidden /><span>{item.label}</span></button>;
          })}
        </nav>
        <div className="sidebar-demo">
          <span>DEMO CONTROLS</span>
          <Button variant="outline" size="sm" onClick={advanceDemo} disabled={role !== "Incident commander" && role !== "Resilience engineer"}><History />Advance 10 min</Button>
          <Button variant="ghost" size="sm" onClick={resetDemo} disabled={role !== "Identity administrator"}><RotateCcw />Reset replay</Button>
        </div>
      </aside>

      <main className="main-region" id="main-content" tabIndex={-1}>{children}</main>

      <footer className="status-rail" aria-label="Operational status">
        <StatusItem icon={CloudRain} label="IMD warning" value="Red · Heavy to very heavy rain" tone="danger" />
        <StatusItem icon={Waves} label="CWC river feed" value="Periyar River: Rising" />
        <StatusItem icon={Gauge} label="Simulation run" value={snapshot.modelVersion} />
        <StatusItem icon={ClipboardList} label="Pending reports" value={`${snapshot.signals.filter((signal) => signal.decision === "UNREVIEWED").length} clusters`} />
        <StatusItem icon={HeartHandshake} label="Shelters" value={`${snapshot.shelters.filter((shelter) => shelter.status === "OPEN").length} confirmed open`} tone="success" />
        <StatusItem icon={CheckCircle2} label="Offline packets" value="3,142 records ready" tone="success" />
        <button type="button" className="rail-refresh" onClick={advanceDemo} disabled={role !== "Incident commander" && role !== "Resilience engineer"}><RefreshCcw aria-hidden />Refresh</button>
      </footer>

      {notice && <div className={`toast toast-${notice.tone}`} role="status">{notice.tone === "success" ? <CheckCircle2 aria-hidden /> : <AlertTriangle aria-hidden />}{notice.message}</div>}
    </div>
  );
}

function StatusItem({ icon: Icon, label, value, tone = "default" }: { icon: typeof Map; label: string; value: string; tone?: "default" | "danger" | "success" }) {
  return <div className="status-item" data-tone={tone}><Icon aria-hidden /><span><strong>{label}</strong><small>{value}</small></span></div>;
}
