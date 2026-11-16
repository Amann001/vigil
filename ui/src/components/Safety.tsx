import { Component, type ErrorInfo, type ReactNode } from "react";

/*
  What keeps the site opening every time, whatever the visitor's machine:
  - hasWebGL: some work laptops and older phones switch 3D graphics off; the site then runs
    without the 3D sky instead of failing to start.
  - loadOnce: a visitor who opened the site before an update asks for a script file the update
    replaced; the page reloads once to fetch the new version.
  - ErrorBoundary: an error in one part shows a message there (or nothing, for decoration)
    rather than a blank page.
*/

export function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

const RELOADED = "vigil.reloaded";

/** Load a lazily imported part; if its file is gone after an update, reload the page once. */
export function loadOnce<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().then(
      (module) => {
        try {
          sessionStorage.removeItem(RELOADED);
        } catch {
          /* fine */
        }
        return module;
      },
      (error: unknown) => {
        let tried = false;
        try {
          tried = sessionStorage.getItem(RELOADED) === "1";
          sessionStorage.setItem(RELOADED, "1");
        } catch {
          tried = true; // no storage: do not risk reloading in a loop
        }
        if (!tried) window.location.reload();
        throw error;
      },
    );
}

interface BoundaryProps {
  children: ReactNode;
  /** What to show instead; nothing by default (for a part that is only decoration). */
  fallback?: ReactNode;
}

export class ErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Part of the war room failed:", error, info.componentStack);
  }

  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

/** Shown if the site itself fails: says what happened and offers the one fix that helps. */
export function SiteError() {
  return (
    <div className="site-error" role="alert">
      <h1>Something went wrong.</h1>
      <p>The page could not start. Reloading usually fixes it.</p>
      <button className="button button-primary" onClick={() => window.location.reload()}>
        Reload the page
      </button>
    </div>
  );
}
