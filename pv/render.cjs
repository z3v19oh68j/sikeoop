// Renders pv/index.html frame by frame into video.mp4 (no audio; mix.sh adds it).
// The page exposes window.seek(t): it lays out the frame at time t (seconds) deterministically,
// so every frame is exact no matter how slow capturing is.
//
//   ../sweet-code-desktop/node_modules/.bin/electron render.cjs [--from 0] [--to 90] [--fps 30] [--out out/video.mp4] [--still 12.5]
const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const W = 1920;
const H = 1080;
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(60);
  await win.loadFile(path.join(__dirname, "index.html"));
  await win.webContents.executeJavaScript("window.ready");

  // Offscreen paints arrive late and capturePage can hand back an older frame, so the page stamps
  // a frame number into its top-left pixel and we keep taking paints until that number shows up.
  let latest = null;
  win.webContents.on("paint", (_e, _dirty, image) => (latest = image));
  let n = 0;
  const stamped = (img, k) => {
    const px = img.crop({ x: 0, y: 0, width: 1, height: 1 }).toBitmap();
    return px[2] === (k & 255) && px[1] === ((k >> 8) & 255) && px[0] === 77;
  };
  const grab = async (t) => {
    const k = ++n;
    await win.webContents.executeJavaScript(`window.seek(${t}, ${k})`);
    let img = null;
    for (let tries = 0; tries < 200; tries++) {
      win.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 8));
      if (latest && stamped(latest, k)) {
        img = latest;
        break;
      }
    }
    if (!img) throw new Error(`frame at ${t}s never painted`);
    const size = img.getSize();
    if (size.width !== W || size.height !== H) throw new Error(`frame is ${size.width}x${size.height}`);
    return img;
  };

  const still = arg("still");
  if (still !== undefined) {
    // Contact sheet mode: one PNG per listed time, for checking the look.
    fs.mkdirSync(path.join(__dirname, "out", "stills"), { recursive: true });
    for (const t of still.split(",").map(Number)) {
      const img = await grab(t);
      fs.writeFileSync(path.join(__dirname, "out", "stills", `${t.toFixed(2)}.png`), img.toPNG());
    }
    app.quit();
    return;
  }

  // The sound cues the page lists, for mix.cjs.
  fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "out", "cues.json"), await win.webContents.executeJavaScript("JSON.stringify(window.CUES)"));
  const fps = Number(arg("fps", 30));
  const from = Number(arg("from", 0));
  const to = Number(arg("to", 90));
  const out = path.resolve(__dirname, arg("out", "out/video.mp4"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const ff = spawn(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${W}x${H}`, "-r", String(fps), "-i", "-",
      "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const frames = Math.round((to - from) * fps);
  const started = Date.now();
  for (let i = 0; i < frames; i++) {
    const img = await grab(from + i / fps);
    if (!ff.stdin.write(img.toBitmap())) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % fps === 0) process.stdout.write(`\r${(i / fps).toFixed(0)}s / ${(frames / fps).toFixed(0)}s  (${((Date.now() - started) / 1000).toFixed(0)}s elapsed)`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  process.stdout.write(`\nwrote ${out}\n`);
  app.quit();
});
