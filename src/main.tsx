import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { desktopPlatform } from "./desktopPlatform";
import { setPlatform } from "./platform";
import "./styles.css";

setPlatform(desktopPlatform);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
