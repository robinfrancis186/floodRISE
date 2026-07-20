import { useEffect, useMemo, useState } from "react";
import { isForcedOfflineMode, NETWORK_MODE_CHANGED_EVENT } from "../lib/network";

export function useNetworkStatus() {
  const initialForcedOffline = useMemo(() => isForcedOfflineMode(), []);
  const [forceOffline, setForceOffline] = useState(initialForcedOffline);
  const [browserOnline, setBrowserOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  useEffect(() => {
    const online = () => setBrowserOnline(true);
    const offline = () => setBrowserOnline(false);
    const modeChanged = () => setForceOffline(isForcedOfflineMode());
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    window.addEventListener(NETWORK_MODE_CHANGED_EVENT, modeChanged);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      window.removeEventListener(NETWORK_MODE_CHANGED_EVENT, modeChanged);
    };
  }, []);

  return {
    isOnline: !forceOffline && browserOnline,
    isForcedOffline: forceOffline
  };
}
