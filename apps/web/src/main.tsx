import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startClient } from "./lib/bootstrap.ts";
import "./styles/global.css";

startClient();

const container = document.getElementById("root");
if (!container) throw new Error("#root missing");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
