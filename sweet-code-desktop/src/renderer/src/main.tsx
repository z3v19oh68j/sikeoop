import { createRoot } from "react-dom/client";
import "./monaco";
import "./skin";
import "./styles/theme.css";
import { App } from "./App";
import { startExtensions } from "./extensions";

// The title bar leaves room for macOS traffic lights on the left, or the Windows caption buttons on the right.
if (!navigator.userAgent.includes("Mac")) document.documentElement.classList.add("not-mac");

async function boot() {
  if (import.meta.env.DEV && !window.sweet) (await import("./dev-mock")).installDevMock();
  // Editor extensions (themes, grammars, snippets) load in the background; files highlight once they're in.
  startExtensions();
  createRoot(document.getElementById("root")!).render(<App />);
}

void boot();
