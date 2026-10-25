import * as React from "react";
import { createRoot } from "react-dom/client";

import "./styles/tokens.css";
import "./styles/app.css";
import "./caption/fonts";

import { App } from "./app/App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
