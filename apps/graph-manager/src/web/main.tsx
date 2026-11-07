import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import App from "./App";
import "./ui/tokens.css";
import "./styles.css";
import "./ui/base.css";
import { applyTheme } from "./ui/theme";
import { ToastProvider } from "./ui/toast";

applyTheme();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ToastProvider>
        <App />
      </ToastProvider>
    </StrictMode>,
  );
}
