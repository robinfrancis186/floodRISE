import { Button, DemoBanner, FloodRiseLogo, Select, SignOutButton, authenticationRequired } from "@floodrise/ui";
import { Command } from "cmdk";
import {
  AlertTriangle,
  Bell,
  Building2,
  CheckCircle2,
  DatabaseZap,
  FileClock,
  History,
  Map,
  Navigation,
  RadioTower,
  RefreshCcw,
  RotateCcw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { StaffRole, ViewId } from "../lib/models";
import { useOperations } from "../state/operations-context";

export const viewConfig: Record<ViewId, { label: string; shortLabel: string; title: string; icon: typeof Map }> = {
  live: { label: "Map", shortLabel: "Map", title: "Operations Map", icon: Map },
  signals: { label: "FloodSignal", shortLabel: "Signals", title: "FloodSignal Review", icon: RadioTower },
  incidents: { label: "Incidents", shortLabel: "Incidents", title: "Incident Management", icon: AlertTriangle },
  evacuation: { label: "Evacuation", shortLabel: "Routes", title: "Evacuation Routing", icon: Navigation },
  shelters: { label: "Shelters", shortLabel: "Shelters", title: "Shelter Operations", icon: Building2 },
  resilience: { label: "Resilience Audit", shortLabel: "Resilience", title: "Resilience Audit", icon: ShieldCheck },
  sources: { label: "Source Health", shortLabel: "Sources", title: "Source Health", icon: DatabaseZap },
  audit: { label: "Audit Log", shortLabel: "Audit", title: "Audit Log", icon: FileClock },
};

export function AppShell({ view, onNavigate, children }: { view: ViewId; onNavigate: (view: ViewId) => void; children: ReactNode }) {
  const { snapshot, connected, streamStatus, role, setRole, allowedRoles, advanceDemo, resetDemo, refresh, loading, notice, setSelectedSignalId, setSelectedShelterId } = useOperations();
  const [searchOpen, setSearchOpen] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const attentionArea = useRef<HTMLDivElement>(null);
  const attentionItems = useMemo(() => [
    ...snapshot.signals.filter((signal) => signal.decision === "UNREVIEWED").map((signal) => ({
      title: `${signal.name} report cluster needs review`, detail: `${signal.independentReports} independent reports · ${signal.confidence}% confidence`, view: "signals" as const, signalId: signal.id,
    })),
    ...snapshot.actions.filter((action) => action.status === "PENDING_APPROVAL").map((action) => ({
      title: `${action.title} awaits approval`, detail: `Request ${action.approvalId ?? "pending"} · ${action.expiresAt}`, view: "evacuation" as const, signalId: undefined,
    })),
  ], [snapshot.actions, snapshot.signals]);
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAttentionOpen(false);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setAttentionOpen(false);
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);
  useEffect(() => {
    if (!attentionOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!attentionArea.current?.contains(event.target as Node)) setAttentionOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [attentionOpen]);
  const time = new Date(snapshot.scenarioTime).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
  const liveUpdatesConnected = connected && streamStatus === "live";
  const syncLabel = !connected
    ? "Read-only demo · API unavailable"
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
        <div className="incident-select" role="group" aria-label="Selected incident: Chennai Cyclone Michaung replay">Chennai <span aria-hidden>•</span> Cyclone Michaung</div>
        <div className="topbar-sync" aria-live="polite">
          <span>Scenario {time} IST</span><span className={liveUpdatesConnected ? "sync-dot connected" : "sync-dot"} aria-hidden />
          <span>{syncLabel}</span>
        </div>
        <button className="global-search" type="button" onClick={() => { setAttentionOpen(false); setSearchOpen(true); }} aria-label="Search locations, assets, or identifiers" aria-keyshortcuts="Meta+K Control+K">
          <Search aria-hidden /><span>Search locations, assets, IDs…</span><kbd>⌘K</kbd>
        </button>
        <div className="notification-area" ref={attentionArea}>
          <Button className="notification-button" variant="ghost" size="icon" aria-label={`Needs attention, ${attentionItems.length} items`} aria-expanded={attentionOpen} aria-controls="attention-panel" onClick={() => setAttentionOpen((open) => !open)}><Bell />{attentionItems.length > 0 && <span>{attentionItems.length}</span>}</Button>
          {attentionOpen && <section className="notification-popover" id="attention-panel" role="region" aria-label="Items needing attention">
            <header><div><strong>Needs attention</strong><small>{attentionItems.length} actionable items</small></div><button type="button" className="icon-quiet" aria-label="Close notifications" onClick={() => setAttentionOpen(false)}>×</button></header>
            {attentionItems.length ? <ul>{attentionItems.map((item) => <li key={item.title}><button type="button" onClick={() => { if (item.signalId) setSelectedSignalId(item.signalId); onNavigate(item.view); setAttentionOpen(false); }}><AlertTriangle aria-hidden /><span><strong>{item.title}</strong><small>{item.detail}</small></span></button></li>)}</ul> : <p className="notification-empty">No outstanding reviews or approvals.</p>}
          </section>}
        </div>
        <label className="role-select">
          <span className="sr-only">Active role</span>
          <Select value={role} onChange={(event) => setRole(event.target.value as StaffRole)}>{allowedRoles.map((item) => <option key={item}>{item}</option>)}</Select>
        </label>
        <SignOutButton />
      </header>

      <aside className="sidebar" aria-label="Primary navigation">
        <nav>
          {(Object.entries(viewConfig) as [ViewId, typeof viewConfig[ViewId]][]).map(([id, item]) => {
            const Icon = item.icon;
            return <button key={id} className="nav-item" title={item.label} aria-label={item.label} data-active={view === id || undefined} onClick={() => onNavigate(id)} aria-current={view === id ? "page" : undefined}><Icon aria-hidden /><span>{item.shortLabel}</span></button>;
          })}
        </nav>
        <a className="nav-item field-app-link" href={import.meta.env.DEV ? "http://localhost:5174/" : "/field/"}><RadioTower aria-hidden /><span>Field reporting</span></a>
        {!authenticationRequired && <div className="sidebar-demo">
          <span>DEMO CONTROLS</span>
          <Button variant="outline" size="sm" onClick={advanceDemo} disabled={!connected || (role !== "Incident commander" && role !== "Resilience engineer")}><History />Advance 10 min</Button>
          <Button variant="ghost" size="sm" onClick={resetDemo} disabled={!connected || role !== "Identity administrator"}><RotateCcw />Reset replay</Button>
        </div>}
      </aside>

      <main className="main-region" id="main-content" tabIndex={-1}>{children}</main>

      <footer className="status-rail" aria-label="Operational status">
        <span className="status-rail-mode"><span className="sync-dot" aria-hidden /> DEMO REPLAY · NOT LIVE</span>
        <span className="status-rail-review">{snapshot.signals.filter((signal) => signal.decision === "UNREVIEWED").length} signal clusters need review</span>
        <span className="status-rail-version">Scenario {time} IST · {snapshot.modelVersion}</span>
        <button type="button" className="rail-refresh" onClick={refresh} disabled={loading}><RefreshCcw aria-hidden className={loading ? "is-spinning" : undefined} />{loading ? "Refreshing…" : "Refresh"}</button>
      </footer>

      {!connected && !loading && <span className="sr-only" role="status">The operations API is unavailable. Displaying a read-only demo; changes cannot be saved.</span>}
      <Command.Dialog open={searchOpen} onOpenChange={setSearchOpen} label="Search floodRISE">
        <div className="command-panel">
          <div className="command-search"><Search aria-hidden /><Command.Input placeholder="Search views, clusters, shelters…" /><kbd>ESC</kbd></div>
          <Command.List>
            <Command.Empty>No matching views or records.</Command.Empty>
            <Command.Group heading="Operations">
              {(Object.entries(viewConfig) as [ViewId, typeof viewConfig[ViewId]][]).map(([id, item]) => { const Icon = item.icon; return <Command.Item key={id} value={`${item.label} ${item.title}`} onSelect={() => { onNavigate(id); setSearchOpen(false); }}><Icon aria-hidden /><span>{item.title}</span><small>Open view</small></Command.Item>; })}
            </Command.Group>
            <Command.Group heading="Report clusters">
              {snapshot.signals.map((signal) => <Command.Item key={signal.id} value={`${signal.id} ${signal.name} ${signal.ward} ${signal.area}`} onSelect={() => { setSelectedSignalId(signal.id); onNavigate("signals"); setSearchOpen(false); }}><Map aria-hidden /><span>{signal.id} · {signal.name}</span><small>{signal.ward}</small></Command.Item>)}
            </Command.Group>
            <Command.Group heading="Shelters">
              {snapshot.shelters.map((shelter) => <Command.Item key={shelter.id} value={`${shelter.id} ${shelter.name} ${shelter.ward}`} onSelect={() => { setSelectedShelterId(shelter.id); onNavigate("shelters"); setSearchOpen(false); }}><Building2 aria-hidden /><span>{shelter.name}</span><small>{shelter.ward}</small></Command.Item>)}
            </Command.Group>
          </Command.List>
          <footer><span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span><span><kbd>↵</kbd> to open</span><span>DEMO DATA</span></footer>
        </div>
      </Command.Dialog>

      {notice && <div className={`toast toast-${notice.tone}`} role="status">{notice.tone === "success" ? <CheckCircle2 aria-hidden /> : <AlertTriangle aria-hidden />}{notice.message}</div>}
    </div>
  );
}
