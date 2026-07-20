import { Alert, AlertDescription, AlertTitle, Badge, Button } from "@floodrise/ui";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, DatabaseZap, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { clearThisDemoDevice, type DemoDeviceResetResult } from "../lib/demo-reset";

type ResetState = "idle" | "clearing" | "complete" | "failed";

export function DemoResetPage() {
  const [state, setState] = useState<ResetState>("idle");
  const [result, setResult] = useState<DemoDeviceResetResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resetThisDevice() {
    setState("clearing");
    setError(null);
    try {
      const cleared = await clearThisDemoDevice();
      setResult(cleared);
      setState("complete");
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Demo reset failed. No local data was removed.");
      setState("failed");
    }
  }

  return (
    <div className="page page-content standard-page demo-reset-page">
      <div className="page-title-row">
        <div>
          <Badge variant="warning">Local demo control</Badge>
          <h1>Reset this demo device</h1>
          <p>Clear flood report drafts and receipts stored by this PWA in this browser profile.</p>
        </div>
        <DatabaseZap aria-hidden className="page-title-icon" />
      </div>

      <Alert variant="warning" className="demo-reset-warning">
        <TriangleAlert aria-hidden className="alert-leading-icon" />
        <div>
          <AlertTitle>One browser profile at a time</AlertTitle>
          <AlertDescription>
            The backend reset script cannot erase browser storage. Open this page and confirm once in every Field PWA browser or profile used for the rehearsal.
          </AlertDescription>
        </div>
      </Alert>

      <section className="demo-reset-scope" aria-labelledby="reset-scope-heading">
        <ShieldCheck aria-hidden />
        <div>
          <h2 id="reset-scope-heading">Safety boundary</h2>
          <p>
            Before deleting anything, the app must reach the same-origin API and verify <strong>DEMO DATA</strong> mode. A live or unreachable API is refused.
          </p>
          <ul>
            <li>Deletes encrypted offline drafts, their device-only encryption key, and report receipts for this PWA origin.</li>
            <li>Clears the displayed last-sync time and forced-offline rehearsal flag.</li>
            <li>Keeps this profile&apos;s reporter and device identifiers so independence and duplicate checks remain meaningful.</li>
          </ul>
        </div>
      </section>

      {state === "complete" && result ? (
        <Alert variant="info" className="demo-reset-result" role="status">
          <CheckCircle2 aria-hidden className="alert-leading-icon" />
          <div>
            <AlertTitle>This browser profile is clean</AlertTitle>
            <AlertDescription>
              Removed {result.queuedDrafts} unsent {result.queuedDrafts === 1 ? "draft" : "drafts"} and {result.receipts} {result.receipts === 1 ? "receipt" : "receipts"}. Verified API environment: {result.environment}.
            </AlertDescription>
          </div>
        </Alert>
      ) : null}

      {state === "failed" && error ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert aria-hidden className="alert-leading-icon" />
          <div><AlertTitle>Nothing was deleted</AlertTitle><AlertDescription>{error}</AlertDescription></div>
        </Alert>
      ) : null}

      <div className="demo-reset-actions">
        <Button
          type="button"
          size="lg"
          variant="destructive"
          onClick={() => void resetThisDevice()}
          disabled={state === "clearing"}
        >
          <Trash2 aria-hidden />
          {state === "clearing" ? "Verifying demo mode…" : state === "complete" ? "Clear this device again" : "Verify and clear this demo device"}
        </Button>
        <Button asChild type="button" size="lg" variant="outline">
          <Link to="/queue">Open offline queue</Link>
        </Button>
      </div>

      <p className="demo-reset-footnote">
        This control does not reset the backend scenario. Run <code>ops/scripts/demo-reset.sh</code> first and verify its canonical incident/time response.
      </p>
    </div>
  );
}
