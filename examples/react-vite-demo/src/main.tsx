import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { installPatchLensInspector } from "@patchlens-ai/inspector-runtime";

import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.DEV) {
  window.requestAnimationFrame(() => {
    installPatchLensInspector();
  });
}
