import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installGlobalProblemHandlers } from "./lib/diagnostics";

installGlobalProblemHandlers();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* Views have their own boundaries inside App. This one is the last resort. */}
    <ErrorBoundary label="this window" fallback="window">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
