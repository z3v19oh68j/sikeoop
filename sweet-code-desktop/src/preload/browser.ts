import { ipcRenderer } from "electron";

// Runs in every page of the built-in browser (an isolated world: the page's own scripts can't see
// it). Three jobs:
//   - for the agent: list the page's interactive elements under numbers, and find / focus them;
//   - for the password store: notice login forms, offer what was typed at submit for saving, and
//     fill a saved login when the user (never the agent) asks;
//   - keep password fields out of the agent's hands: their values are never read for it and it
//     can't focus or type into them.
// Talks only to the main process (browser/service.ts), which checks that messages come from the
// browser's own page.

const REF = "data-sikeoop-ref";
const MAX_ELEMENTS = 160;
const MAX_TEXT = 6000;

const isPassword = (el: Element | null): boolean =>
  !!el && el instanceof HTMLInputElement && (el.type === "password" || el.autocomplete === "current-password" || el.autocomplete === "new-password");

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
}

function label(el: Element): string {
  const aria = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt");
  if (aria) return aria.trim();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const id = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return ((id && id.textContent) || el.placeholder || el.name || "").trim();
  }
  return (el.textContent || "").replace(/\s+/g, " ").trim();
}

function describe(el: Element, n: number): string {
  const tag = el.tagName.toLowerCase();
  const name = label(el).slice(0, 80);
  if (isPassword(el)) return `[${n}] password field "${name}" (${(el as HTMLInputElement).value ? "filled" : "empty"}) — the user logs in themselves`;
  if (tag === "a") return `[${n}] link "${name}" → ${(el as HTMLAnchorElement).getAttribute("href") ?? ""}`;
  if (tag === "input") {
    const i = el as HTMLInputElement;
    if (i.type === "checkbox" || i.type === "radio") return `[${n}] ${i.type} "${name}" ${i.checked ? "checked" : "unchecked"}`;
    if (i.type === "submit" || i.type === "button") return `[${n}] button "${i.value || name}"`;
    return `[${n}] textbox(${i.type}) "${name}"${i.value ? ` value="${i.value.slice(0, 80)}"` : ""}`;
  }
  if (tag === "textarea") return `[${n}] textarea "${name}"${(el as HTMLTextAreaElement).value ? ` value="${(el as HTMLTextAreaElement).value.slice(0, 80)}"` : ""}`;
  if (tag === "select") {
    const s = el as HTMLSelectElement;
    return `[${n}] select "${name}" = "${s.selectedOptions[0]?.textContent?.trim() ?? ""}" options: ${[...s.options].slice(0, 12).map((o) => o.textContent?.trim()).join(" | ")}`;
  }
  return `[${n}] ${el.getAttribute("role") || tag} "${name}"`;
}

function snapshot(): string {
  document.querySelectorAll(`[${REF}]`).forEach((el) => el.removeAttribute(REF));
  const all = [
    ...document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="menuitem"], [contenteditable="true"]',
    ),
  ].filter(visible);
  // Elements on screen first, then the rest of the page.
  const inView = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight;
  };
  const ordered = [...all.filter(inView), ...all.filter((e) => !inView(e))].slice(0, MAX_ELEMENTS);
  const lines = ordered.map((el, i) => {
    el.setAttribute(REF, String(i + 1));
    return describe(el, i + 1);
  });
  const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, MAX_TEXT);
  return [
    `Page: ${document.title}`,
    `URL: ${location.href}`,
    `Scroll: ${Math.round(scrollY)} / ${Math.max(0, document.documentElement.scrollHeight - innerHeight)}`,
    "",
    `Elements (${lines.length}${all.length > lines.length ? ` of ${all.length}` : ""}; use the number with browser_act):`,
    ...lines,
    "",
    "Visible text:",
    text,
  ].join("\n");
}

function find(ref: number): Element {
  const el = document.querySelector(`[${REF}="${ref}"]`);
  if (!el) throw new Error(`No element [${ref}] on the page now. Take a new browser_snapshot.`);
  return el;
}

type Op =
  | { op: "snapshot" }
  | { op: "rect"; ref: number }
  | { op: "focus"; ref: number; clear?: boolean }
  | { op: "select"; ref: number; value: string }
  | { op: "scroll"; dy: number; ref?: number }
  | { op: "origin" };

function run(msg: Op): unknown {
  switch (msg.op) {
    case "snapshot":
      return snapshot();
    case "origin":
      return location.origin;
    case "rect": {
      const el = find(msg.ref);
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      const inForm = !!el.closest("form");
      const submits = inForm && (el.matches('button:not([type="button"]), input[type="submit"]') || false);
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, submits, label: label(el).slice(0, 60) };
    }
    case "focus": {
      const el = find(msg.ref);
      if (isPassword(el)) throw new Error("That is a password field. The agent never types passwords: ask the user to log in themselves.");
      el.scrollIntoView({ block: "center" });
      (el as HTMLElement).focus();
      if (msg.clear && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.select();
      return true;
    }
    case "select": {
      const el = find(msg.ref);
      if (!(el instanceof HTMLSelectElement)) throw new Error(`[${msg.ref}] is not a select box.`);
      const opt = [...el.options].find((o) => o.value === msg.value || o.textContent?.trim() === msg.value);
      if (!opt) throw new Error(`No option "${msg.value}" in [${msg.ref}].`);
      el.value = opt.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    case "scroll": {
      if (msg.ref) find(msg.ref).scrollIntoView({ block: "center" });
      else scrollBy({ top: msg.dy, behavior: "instant" as ScrollBehavior });
      return Math.round(scrollY);
    }
  }
}

ipcRenderer.on("sikeoop-agent", (_e, msg: Op & { id: number }) => {
  let reply: { id: number; ok: boolean; value?: unknown; error?: string };
  try {
    reply = { id: msg.id, ok: true, value: run(msg) };
  } catch (err) {
    reply = { id: msg.id, ok: false, error: (err as Error).message };
  }
  ipcRenderer.send("browser-page:reply", reply);
});

// ---- logins ----------------------------------------------------------------------------

/** The username box that goes with a password box: the closest text/email input before it. */
function userFieldFor(pw: HTMLInputElement): HTMLInputElement | null {
  const scope = pw.form ?? document;
  const inputs = [...scope.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="email"], input[type="tel"], input:not([type])')].filter(visible);
  const before = inputs.filter((i) => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
  return before[before.length - 1] ?? inputs[0] ?? null;
}

const passwordField = () => [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].find(visible) ?? null;

let announced = false;
function checkLoginForm() {
  const has = !!passwordField();
  if (has !== announced) {
    announced = has;
    ipcRenderer.send("browser-page:login-form", { origin: location.origin, present: has });
  }
}

// At submit (or the click/Enter that usually submits), offer what was typed for saving.
function offer() {
  const pw = passwordField();
  if (!pw || !pw.value) return;
  const user = userFieldFor(pw);
  ipcRenderer.send("browser-page:credential", { origin: location.origin, username: user?.value ?? "", password: pw.value });
}
addEventListener("submit", offer, true);
addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Enter" && isPassword(document.activeElement)) offer();
  },
  true,
);
addEventListener(
  "click",
  (e) => {
    const t = e.target as Element | null;
    if (t?.closest('button, input[type="submit"], [role="button"]') && passwordField()?.value) offer();
  },
  true,
);

/** The user chose a saved login: fill both boxes the way typing would. */
ipcRenderer.on("sikeoop-fill", (_e, { username, password }: { username: string; password: string }) => {
  const pw = passwordField();
  if (!pw) return;
  const set = (el: HTMLInputElement, v: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const user = userFieldFor(pw);
  if (user && username) set(user, username);
  set(pw, password);
});

addEventListener("DOMContentLoaded", () => {
  checkLoginForm();
  // Pages change all the time; look again at most a few times a second.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      checkLoginForm();
    }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });
});
