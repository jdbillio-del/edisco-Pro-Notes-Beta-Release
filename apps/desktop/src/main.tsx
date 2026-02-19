import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import VaultGate from "./VaultGate";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <VaultGate>
      <App />
    </VaultGate>
  </React.StrictMode>
);
