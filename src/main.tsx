import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/google-sans-flex/opsz.css";
import "./styles.css";
import { App } from "./App";
import { api } from "./api";

window.addEventListener("error", (e) => api.log("error", `${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => api.log("error", `unhandled: ${e.reason}`));

// A launcher has no use for the browser's context menu.
window.addEventListener("contextmenu", (e) => e.preventDefault());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
