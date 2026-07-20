export function MapFallback({ height = 420 }: { height?: number }) {
  return (
    <div className="map-skeleton" style={{ height }} role="status" aria-label="Loading flood conditions map">
      <span className="map-skeleton-pulse" />
      <span>Loading local map…</span>
    </div>
  );
}
