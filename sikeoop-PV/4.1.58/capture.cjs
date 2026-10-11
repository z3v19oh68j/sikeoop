// Renders pv.html frame by frame in an offscreen Electron window (based on the 4.1 PV's capture.cjs).
//   electron capture.cjs video <out.mp4> [fps]   → silent H.264 video
//   electron capture.cjs stills <dir> t1,t2,…    → PNG stills at those seconds
// Before rendering it injects the whale-girl SVGs (ids prefixed so they don't clash) as window.SVGS,
// and every frame pins all CSS animations to the frame time so the SVG loops are deterministic.
// Also writes timeline.json (scene starts, voice starts, sound cues) for the mix.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

app.commandLine.appendSwitch("force-device-scale-factor", "1");
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("capture.cjs")) + 1);
const [mode, out, extra] = args;

const svgs = {};
for (const n of ["work", "sleepy", "waiting", "lazy", "error", "icon"]) {
  let s = fs.readFileSync(path.join(__dirname, "art", `${n}.svg`), "utf8").replace(/<\?xml[^>]*>/, "");
  const ids = [...s.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  for (const id of ids) s = s.split(`"${id}"`).join(`"${n}-${id}"`).split(`#${id})`).join(`#${n}-${id})`).split(`"#${id}"`).join(`"#${n}-${id}"`);
  svgs[n] = s.replace(/<svg /, '<svg width="100%" height="100%" ');
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1920, height: 1080, show: false, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, "pv.html"));
  const exec = (js) => win.webContents.executeJavaScript(js);
  await exec(`window.SVGS = ${JSON.stringify(svgs)}; window.boot && window.boot();`);
  for (let i = 0; i < 100 && !(await exec("!!(window.PV && window.PV.ready)")); i++) await new Promise((r) => setTimeout(r, 100));
  const pv = JSON.parse(await exec("JSON.stringify(window.PV)"));
  fs.writeFileSync(path.join(__dirname, "timeline.json"), JSON.stringify(pv, null, 1));
  const frame = async (t) => {
    await exec(`renderAt(${t}); document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${t * 1000}; }); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    return (await win.webContents.capturePage()).toPNG();
  };
  if (mode === "stills") {
    fs.mkdirSync(out, { recursive: true });
    for (const t of extra.split(",").map(Number)) fs.writeFileSync(path.join(out, `t${t.toFixed(2).padStart(6, "0")}.png`), await frame(t));
  } else {
    const fps = Number(extra || 30);
    const n = Math.round(pv.total * fps);
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps), out], { stdio: ["pipe", "inherit", "inherit"] });
    for (let i = 0; i < n; i++) {
      const png = await frame(i / fps);
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
      if (i % 300 === 0) console.log(`frame ${i}/${n}`);
    }
    ff.stdin.end();
    await new Promise((r) => ff.on("close", r));
    console.log("video done", out);
  }
  app.quit();
});
