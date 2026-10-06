import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { authenticationHeaders, authenticationRequired, initializeSession, onSessionExpired, signIn, signOut } from "../lib/session";
import { FloodRiseLogo } from "./brand";

type Session = { userId: string; roles: string[] };
const SessionContext = createContext<Session | null>(null);
export const useSession = () => useContext(SessionContext);

export function SessionGate({ children, onAuthenticated }: { children: ReactNode; onAuthenticated?: (userId: string) => Promise<void> }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(authenticationRequired);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!authenticationRequired) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const user = await initializeSession();
        unsubscribe = onSessionExpired(() => { setSession(null); setError("Your session has expired. Sign in to continue."); });
        if (disposed || !user || user.expired) return;
        const root = import.meta.env.VITE_API_ROOT ?? import.meta.env.VITE_API_BASE_URL ?? "/api/v1";
        const response = await fetch(`${root.replace(/\/$/, "")}/auth/me`, {
          headers: await authenticationHeaders(), cache: "no-store", signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) throw new Error("Your account could not be verified by the API. Contact the incident administrator.");
        const data = await response.json();
        if (data.authenticated !== true || typeof data.user_id !== "string" || !Array.isArray(data.roles) || !data.roles.length || data.roles.some((role: unknown) => typeof role !== "string")) {
          throw new Error("The API returned an invalid account. Access remains disabled.");
        }
        if (!disposed) {
          await onAuthenticated?.(data.user_id);
          if (!disposed) setSession({ userId: data.user_id, roles: data.roles });
        }
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : "Sign-in is unavailable. Try again.");
      } finally {
        if (disposed) unsubscribe?.();
        else setLoading(false);
      }
    })();
    return () => { disposed = true; unsubscribe?.(); };
  }, [onAuthenticated]);
  if (!authenticationRequired) return children;
  if (session) return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
  return <main className="fr-recovery"><FloodRiseLogo /><h1>{loading ? "Checking your account…" : "Sign in to floodRISE"}</h1>
    <p>{error || "Use your authorized incident-response account. Permissions are verified by the server."}</p>
    {loading ? <p role="status">Connecting securely…</p> : <button type="button" onClick={() => { void signIn().catch((failure) => setError(failure.message)); }}>Sign in securely</button>}
  </main>;
}

export function SignOutButton() {
  const session = useSession();
  const [error, setError] = useState("");
  if (!session) return null;
  return <span><button type="button" onClick={() => { void signOut().catch(() => { setError("Sign-out could not reach the identity provider. Reload to clear this session."); }); }}>Sign out</button>{error && <span role="alert">{error}</span>}</span>;
}
