import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AndroidDevice, AndroidState } from "@shared/types";

/**
 * Android emulators on this computer, driven through the Android SDK that Android Studio
 * installs: `emulator` starts the virtual devices (AVDs), `adb` talks to them. Works on macOS
 * and Windows. docker-android is not used because it needs KVM, which only Linux has.
 */

const SERIAL = /^[\w.:-]+$/;
const AVD = /^[\w.-]+$/;

const sdkCandidates = (): string[] => {
  const home = os.homedir();
  const defaults =
    process.platform === "darwin"
      ? [path.join(home, "Library/Android/sdk")]
      : process.platform === "win32"
        ? [path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData/Local"), "Android/Sdk")]
        : [path.join(home, "Android/Sdk")];
  return [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, ...defaults].filter((p): p is string => !!p);
};

/** The Android SDK folder on this computer, or null when none is installed. */
export function sdkRoot(): string | null {
  return sdkCandidates().find((p) => fs.existsSync(p)) ?? null;
}

const toolPath = (root: string, tool: "adb" | "emulator"): string => {
  const exe = process.platform === "win32" ? `${tool}.exe` : tool;
  return path.join(root, tool === "adb" ? "platform-tools" : "emulator", exe);
};

/** The path to adb or emulator, or an error the user can act on. */
const requireTool = (tool: "adb" | "emulator"): string => {
  const root = sdkRoot();
  if (!root) throw new Error("没有找到 Android SDK。请先安装 Android Studio，或设置环境变量 ANDROID_HOME。");
  const file = toolPath(root, tool);
  if (!fs.existsSync(file)) throw new Error(`Android SDK 里没有 ${tool}：${file}。请在 SDK Manager 里安装对应组件。`);
  return file;
};

const run = (file: string, args: string[], timeout = 15_000) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) =>
      err ? reject(new Error((errOut || err.message).trim())) : resolve(out),
    ),
  );

const parseAvds = (out: string): string[] =>
  out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => AVD.test(line));

/** `adb devices` prints a header line, then one "serial<TAB>state" line per device. */
const parseDevices = (out: string): AndroidDevice[] =>
  out
    .split(/\r?\n/)
    .filter((line) => line.includes("\t"))
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial]) => SERIAL.test(serial))
    .map(([serial, state]) => ({ serial, state }));

const checkSerial = (serial: string) => {
  if (!SERIAL.test(serial)) throw new Error("设备序列号不合法");
};

export async function androidState(): Promise<AndroidState> {
  const root = sdkRoot();
  if (!root) return { sdkRoot: null, adb: false, emulator: false, avds: [], devices: [] };
  const adb = toolPath(root, "adb");
  const emulator = toolPath(root, "emulator");
  const hasAdb = fs.existsSync(adb);
  const hasEmulator = fs.existsSync(emulator);
  const [avds, devices] = await Promise.all([
    hasEmulator ? run(emulator, ["-list-avds"]).then(parseAvds).catch(() => []) : Promise.resolve([]),
    hasAdb ? run(adb, ["devices"]).then(parseDevices).catch(() => []) : Promise.resolve([]),
  ]);
  return { sdkRoot: root, adb: hasAdb, emulator: hasEmulator, avds, devices };
}

/** Starts an AVD in its own window. It keeps running after this call returns. */
export async function startAvd(name: string): Promise<void> {
  if (!AVD.test(name)) throw new Error("模拟器名字不合法");
  const emulator = requireTool("emulator");
  const avds = parseAvds(await run(emulator, ["-list-avds"]));
  if (!avds.includes(name)) throw new Error(`没有这个模拟器：${name}`);
  const child = spawn(emulator, ["-avd", name], { detached: true, stdio: "ignore", windowsHide: true });
  // A failed launch shows up as a missing device in the list, so the error needs no extra handling here.
  child.on("error", () => undefined);
  child.unref();
}

export async function stopDevice(serial: string): Promise<void> {
  checkSerial(serial);
  await run(requireTool("adb"), ["-s", serial, "emu", "kill"]);
}

export async function installApk(serial: string, apk: string): Promise<string> {
  checkSerial(serial);
  if (!apk.toLowerCase().endsWith(".apk") || !fs.existsSync(apk)) throw new Error("请选择一个存在的 .apk 文件");
  const out = (await run(requireTool("adb"), ["-s", serial, "install", "-r", apk], 300_000)).trim();
  if (/Failure/i.test(out)) throw new Error(out);
  return out;
}

/** The device screen as a PNG data URL. */
export function screenshot(serial: string): Promise<string> {
  checkSerial(serial);
  const adb = requireTool("adb");
  return new Promise((resolve, reject) =>
    execFile(
      adb,
      ["-s", serial, "exec-out", "screencap", "-p"],
      { encoding: "buffer", windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
      (err, out) => (err ? reject(err) : resolve(`data:image/png;base64,${out.toString("base64")}`)),
    ),
  );
}

/** Runs adb against one device and returns its output (for the agent's Android tools). */
export async function adbRun(serial: string, args: string[], timeout = 20_000): Promise<string> {
  checkSerial(serial);
  return run(requireTool("adb"), ["-s", serial, ...args], timeout);
}

/** Names of the AVDs on this computer. */
export async function listAvds(): Promise<string[]> {
  return parseAvds(await run(requireTool("emulator"), ["-list-avds"]));
}
