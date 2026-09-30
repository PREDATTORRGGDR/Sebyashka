import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { initTelegram, prefersDark } from "./telegram";
import { Backdrop, ToastProvider } from "./ui";

const dark = prefersDark();
document.documentElement.dataset.theme = dark ? "dark" : "light";
initTelegram(dark);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Backdrop />
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
