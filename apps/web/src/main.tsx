import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { BootGate } from "./components/shell/BootGate.tsx";
import { ErrorBoundary } from "./components/shell/ErrorBoundary.tsx";
import { applyDesktopFlag, startClient } from "./lib/bootstrap.ts";
// explicit, not transitive: importing the store stamps `data-theme` / `data-density`
// on <html> before the first React paint (index.html has already done a rough pass)
import "./state/settings.ts";
import "./styles/global.css";
import { registerServiceWorker } from "./lib/registerSw.ts";

applyDesktopFlag();
startClient();
if (import.meta.env.PROD) registerServiceWorker();

const container = document.getElementById("root");
if (!container) throw new Error("#root missing");
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <BootGate>
        <App />
      </BootGate>
    </ErrorBoundary>
  </StrictMode>,
);
