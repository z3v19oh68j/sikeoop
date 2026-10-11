// Runs inside every prototype page (a sandboxed frame). It only talks to the studio through
// postMessage: clicks on [data-goto="<screen id>"] become navigation in the demo, and script
// errors in the page are reported so the user (and later the AI) can see them.
(() => {
  if (window.__sweetProto) return;
  window.__sweetProto = true;
  const post = (msg) => parent.postMessage(Object.assign({ __sweetProto: true }, msg), "*");

  document.addEventListener(
    "click",
    (e) => {
      const el = e.target instanceof Element ? e.target.closest("[data-goto]") : null;
      if (!el) return;
      e.preventDefault();
      post({ type: "goto", to: el.getAttribute("data-goto") || "" });
    },
    true,
  );
  // Plain links inside a prototype never navigate the frame away from the page.
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (a && !a.hasAttribute("data-goto") && !(a.getAttribute("href") || "").startsWith("#")) e.preventDefault();
    },
    true,
  );
  window.addEventListener("error", (e) => post({ type: "error", message: String(e.message || e) }));
  const ready = () => post({ type: "ready", title: document.title });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
})();
