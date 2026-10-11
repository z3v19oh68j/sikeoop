#!/usr/bin/env node
// harmony-emu: the base layer for HarmonyOS emulator work. It finds the tools that ship with
// DevEco Studio (hdc, hvigorw, ohpm, the emulator), and wraps the few hdc operations the cluster
// needs. It installs nothing: DevEco Studio does that, and the emulator image comes with it.
//
// Exit codes: 0 ok · 1 command failed · 2 blocked (a tool or device is missing).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";
const BAT = WIN ? ".bat" : "";

/** Where DevEco Studio usually lives, checked when DEVECO_HOME is not set. */
const DEFAULT_DEVECO = WIN
  ? [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Huawei", "DevEco Studio")]
  : ["/Applications/DevEco-Studio.app/Contents"];

function firstExisting(paths) {
  return paths.find((p) => p && fs.existsSync(p));
}

/**
 * Resolve every tool once. Each one comes from its own *_BIN variable if set, otherwise from
 * DEVECO_HOME (or the default install location). A missing tool stays null and is reported.
 */
export function resolveTools(env = process.env) {
  const home = firstExisting([env.DEVECO_HOME, ...DEFAULT_DEVECO]) ?? null;
  const pick = (envVar, candidates) => firstExisting([env[envVar], ...candidates.map((c) => (home ? path.join(home, c) : null))]) ?? null;
  return {
    devecoHome: home,
    hdc: pick("HDC_BIN", [`sdk/default/openharmony/toolchains/hdc${EXE}`]),
    hvigorw: pick("HVIGORW_BIN", [`tools/hvigor/bin/hvigorw${BAT}`]),
    ohpm: pick("OHPM_BIN", [`tools/ohpm/bin/ohpm${BAT}`]),
    // The emulator's location differs between DevEco versions; set HARMONY_EMULATOR_BIN if it is not found.
    emulator: pick("HARMONY_EMULATOR_BIN", [`tools/emulator/Emulator${EXE}`, `tools/emulator/bin/Emulator${EXE}`]),
  };
}

function run(bin, args, opts = {}) {
  return spawnSync(bin, args, { encoding: "utf8", shell: WIN && bin.endsWith(".bat"), windowsHide: true, ...opts });
}

function hdcOut(tools, args) {
  const r = run(tools.hdc, args, { timeout: 20_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Connected targets (emulators and devices). Empty when none, or when hdc is missing. */
export function listTargets(tools) {
  if (!tools.hdc) return [];
  const { out } = hdcOut(tools, ["list", "targets"]);
  return out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^\[?empty/i.test(s) && !/fail/i.test(s));
}

function say(msg) {
  process.stdout.write(msg + "\n");
}

function need(tools, name) {
  if (tools[name]) return tools[name];
  say(`[blocked] 没有找到 ${name}。设置环境变量 ${name === "hdc" ? "HDC_BIN" : name.toUpperCase() + "_BIN"}，或设置 DEVECO_HOME 指向 DevEco Studio 的安装目录。`);
  process.exit(2);
}

function pickTarget(tools, wanted) {
  const targets = listTargets(tools);
  if (targets.length === 0) {
    say("[blocked] 没有连接的鸿蒙设备或模拟器。先在 DevEco Studio 的 Device Manager 里启动模拟器，再运行 targets 确认。");
    process.exit(2);
  }
  if (wanted) {
    if (!targets.includes(wanted)) {
      say(`[blocked] 设备 ${wanted} 不在线。当前设备：${targets.join(", ")}`);
      process.exit(2);
    }
    return wanted;
  }
  return targets[0];
}

const commands = {
  doctor() {
    const t = resolveTools();
    const row = (label, p) => say(`${p ? "  ok  " : "  --  "} ${label.padEnd(10)} ${p ?? "未找到"}`);
    say("鸿蒙模拟器底座检查");
    row("DEVECO_HOME", t.devecoHome);
    row("hdc", t.hdc);
    row("hvigorw", t.hvigorw);
    row("ohpm", t.ohpm);
    row("emulator", t.emulator);
    if (t.hdc) {
      const v = hdcOut(t, ["version"]);
      say(`      hdc 版本：${v.out.split(/\r?\n/)[0] || "未知"}`);
    }
    const missing = ["hdc", "hvigorw", "ohpm"].filter((k) => !t[k]);
    if (missing.length) {
      say(`\n缺少：${missing.join(", ")}。这些工具随 DevEco Studio 安装。`);
      return 2;
    }
    const targets = listTargets(t);
    say(targets.length ? `\n在线设备：${targets.join(", ")}` : "\n没有在线设备（模拟器未启动，或还没有创建模拟器）。");
    say(t.emulator ? "" : "未找到模拟器可执行文件。如需用命令启动，设置 HARMONY_EMULATOR_BIN。");
    return 0;
  },

  targets() {
    const t = resolveTools();
    need(t, "hdc");
    const list = listTargets(t);
    if (list.length === 0) return say("没有在线设备。"), 2;
    list.forEach((x) => say(x));
    return 0;
  },

  install(args) {
    const [hap, device] = args;
    if (!hap) return say("用法：install <file.hap> [设备号]"), 1;
    if (!fs.existsSync(hap)) return say(`文件不存在：${hap}`), 1;
    const t = resolveTools();
    need(t, "hdc");
    const target = pickTarget(t, device);
    const r = hdcOut(t, ["-t", target, "app", "install", path.resolve(hap)]);
    say(r.out);
    return r.ok && /success/i.test(r.out) ? 0 : 1;
  },

  uninstall(args) {
    const [bundle, device] = args;
    if (!bundle) return say("用法：uninstall <bundleName> [设备号]"), 1;
    const t = resolveTools();
    need(t, "hdc");
    const target = pickTarget(t, device);
    const r = hdcOut(t, ["-t", target, "app", "uninstall", bundle]);
    say(r.out);
    return r.ok && /success/i.test(r.out) ? 0 : 1;
  },

  launch(args) {
    const [bundle, ability, device] = args;
    if (!bundle || !ability) return say("用法：launch <bundleName> <AbilityName> [设备号]"), 1;
    const t = resolveTools();
    need(t, "hdc");
    const target = pickTarget(t, device);
    const r = hdcOut(t, ["-t", target, "shell", "aa", "start", "-a", ability, "-b", bundle]);
    say(r.out);
    return r.ok ? 0 : 1;
  },

  shot(args) {
    const [out, device] = args;
    if (!out) return say("用法：shot <输出.jpeg> [设备号]"), 1;
    const t = resolveTools();
    need(t, "hdc");
    const target = pickTarget(t, device);
    const remote = "/data/local/tmp/harmony-emu-shot.jpeg";
    const a = hdcOut(t, ["-t", target, "shell", "snapshot_display", "-f", remote]);
    const b = hdcOut(t, ["-t", target, "file", "recv", remote, path.resolve(out)]);
    say(b.out || a.out);
    return a.ok && b.ok ? 0 : 1;
  },

  logs(args) {
    const [filter = "", device] = args;
    const t = resolveTools();
    need(t, "hdc");
    const target = pickTarget(t, device);
    // hilog streams until stopped; this prints the buffered lines and returns.
    const r = run(t.hdc, ["-t", target, "hilog", "-z", "300"], { timeout: 15_000 });
    const lines = `${r.stdout ?? ""}`.split(/\r?\n/);
    const keep = filter ? lines.filter((l) => l.includes(filter)) : lines;
    say(keep.join("\n"));
    return 0;
  },

  /** Pass any other arguments straight to hdc, with the same tool resolution. */
  hdc(args) {
    const t = resolveTools();
    need(t, "hdc");
    const r = run(t.hdc, args, { stdio: "inherit" });
    return r.status ?? 1;
  },
};

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "-h") {
    say("用法：harmony-emu <doctor|targets|install|uninstall|launch|shot|logs|hdc> [参数]");
    return 0;
  }
  const fn = commands[cmd];
  if (!fn) return say(`未知命令：${cmd}`), 1;
  return fn(rest);
}

// Run only when executed directly, so the module can be imported for resolveTools/listTargets.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
