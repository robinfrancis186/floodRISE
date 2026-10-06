import { Component, type ReactNode } from "react";
import { FloodRiseLogo } from "./brand";

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="fr-recovery" role="alert"><FloodRiseLogo /><h1>This view could not load</h1>
      <p>Reload the app to try again. Saved field reports remain on this device.</p>
      <button type="button" onClick={() => window.location.reload()}>Reload app</button>
    </main>;
  }
}
