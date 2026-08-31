import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyDesktopFlag, startClient } from "./lib/bootstrap.ts";
// explicit, not transitive: importing the store stamps `data-theme` / `data-density`
// on <html> before the first React paint (index.html has already done a rough pass)
import "./state/settings.ts";
import "./styles/global.css";

applyDesktopFlag();
startClient();

const container = document.getElementById("root");
if (!container) throw new Error("#root missing");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
