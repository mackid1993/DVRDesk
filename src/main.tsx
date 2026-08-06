import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installClientErrorLogging } from "./lib/clientErrorLog";
import "./themes.css";
import "./reset.css";

/**
 * Right-clicking anywhere in the packaged app pops Chromium's own context menu
 * ("Back", "Reload", "View page source", "Inspect"), which exposes that this is
 * a webview and offers actions that make no sense for a desktop app. Suppress
 * it in Tauri builds only, so browser dev keeps devtools reachable, and leave
 * editable fields alone so their native cut/copy/paste menu still works.
 */
function installContextMenuSuppression(): void {
  if (!window.__TAURI_INTERNALS__) return;
  document.addEventListener("contextmenu", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable='true']")) return;
    event.preventDefault();
  });
}

installClientErrorLogging();
installContextMenuSuppression();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
