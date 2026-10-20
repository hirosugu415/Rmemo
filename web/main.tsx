import React from "react";
import ReactDOM from "react-dom/client";
import "../src/styles.css";
import "./web.css";
import WebApp from "./WebApp";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WebApp />
  </React.StrictMode>,
);

// Offline start + "add to home screen". Not in dev, where it would cache
// Vite's live modules.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
