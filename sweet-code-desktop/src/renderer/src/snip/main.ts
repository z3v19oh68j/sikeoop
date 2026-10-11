import "@fontsource-variable/geist";
import "./snip.css";
import type { SnipApi } from "@shared/types";

// The screenshot overlay: the frozen screen, dimmed; drag a box to keep a part of it.

declare global {
  interface Window {
    snip: SnipApi;
  }
}

const img = document.getElementById("shot") as HTMLImageElement;
const box = document.getElementById("box")!;
const size = document.getElementById("size")!;
const hint = document.getElementById("hint")!;
let start: { x: number; y: number } | null = null;
let rect = { x: 0, y: 0, width: 0, height: 0 };

window.snip.onImage((url) => {
  img.src = url;
});

function draw(): void {
  box.hidden = rect.width < 2 || rect.height < 2;
  box.style.left = `${rect.x}px`;
  box.style.top = `${rect.y}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  // The dimmed shade keeps a clear hole where the box is.
  document.body.style.setProperty("--hole", `${rect.x}px ${rect.y}px ${rect.width}px ${rect.height}px`);
  size.textContent = `${Math.round(rect.width * devicePixelRatio)} × ${Math.round(rect.height * devicePixelRatio)}`;
}

window.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  start = { x: e.clientX, y: e.clientY };
  rect = { x: e.clientX, y: e.clientY, width: 0, height: 0 };
  hint.hidden = true;
  document.body.classList.add("selecting");
  draw();
});
window.addEventListener("mousemove", (e) => {
  if (!start) return;
  rect = {
    x: Math.min(start.x, e.clientX),
    y: Math.min(start.y, e.clientY),
    width: Math.abs(e.clientX - start.x),
    height: Math.abs(e.clientY - start.y),
  };
  draw();
});
window.addEventListener("mouseup", () => {
  if (!start) return;
  start = null;
  // A click without a drag is not a selection: keep waiting.
  if (rect.width < 4 || rect.height < 4) {
    document.body.classList.remove("selecting");
    hint.hidden = false;
    rect = { x: 0, y: 0, width: 0, height: 0 };
    draw();
    return;
  }
  window.snip.done(rect);
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.snip.done(null);
  else if (e.key === "Enter") window.snip.done({ x: 0, y: 0, width: 0, height: 0 });
});
// Right click cancels, like most screenshot tools.
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.snip.done(null);
});
