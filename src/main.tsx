import { Component, ErrorInfo, ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ReadWiseHub render error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      const german = navigator.language.toLowerCase().startsWith("de");
      return (
        <main className="app-error-boundary">
          <section className="app-error-card">
            <p className="eyebrow">ReadWiseHub</p>
            <h1>{german ? "ReadWiseHub konnte nicht geladen werden." : "ReadWiseHub could not load."}</h1>
            <p>
              {german
                ? "Bitte lade die Seite neu. Falls das Problem bleibt, kehre zur Startseite zurück."
                : "Please refresh the page. If the problem continues, return to the start page."}
            </p>
            <div className="book-actions">
              <button className="button primary" type="button" onClick={() => window.location.reload()}>
                {german ? "Neu laden" : "Refresh"}
              </button>
              <a className="button secondary" href="/">
                {german ? "Zur Startseite" : "Start page"}
              </a>
            </div>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
);
