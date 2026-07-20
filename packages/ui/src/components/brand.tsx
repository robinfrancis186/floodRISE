import { Waves } from "lucide-react";

export function FloodRiseLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-primary" aria-label="floodRISE">
      <span className="flex size-8 items-center justify-center rounded-md bg-flood/8"><Waves aria-hidden className="size-6 text-flood" /></span>
      {!compact && <span className="text-xl font-extrabold tracking-tight">floodRISE</span>}
    </div>
  );
}

export function DemoBanner() {
  return <div className="flex h-7 items-center justify-center bg-demo px-3 text-center text-xs font-extrabold tracking-[0.14em] text-demo-foreground" role="status">DEMO DATA • NOT LIVE • CYCLONE MICHAUNG REPLAY</div>;
}
