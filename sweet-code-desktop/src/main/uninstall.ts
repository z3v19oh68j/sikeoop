import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app, dialog, shell, type BrowserWindow } from "electron";

// "Uninstall sikeoop" from inside the app, for every way it ships:
// - Windows installer build: runs the uninstaller the installer left next to the exe.
// - Windows portable build: there is nothing installed; the exe is shown so it can be deleted.
// - macOS: the app bundle goes to the Trash.
// The user's data (conversations, settings, keys) is only removed when they tick the box.

/** How this copy of the app can be removed. */
type Kind = "win-installed" | "win-portable" | "mac" | "unsupported";

function uninstallerPath(): string {
  return path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`);
}

function macBundle(): string | null {
  const at = process.execPath.indexOf(".app/");
  return at < 0 ? null : process.execPath.slice(0, at + 4);
}

function kind(): Kind {
  if (!app.isPackaged) return "unsupported";
  if (process.platform === "win32") {
    if (process.env.PORTABLE_EXECUTABLE_FILE) return "win-portable";
    return existsSync(uninstallerPath()) ? "win-installed" : "unsupported";
  }
  if (process.platform === "darwin") return macBundle() ? "mac" : "unsupported";
  return "unsupported";
}

const WHAT: Record<Exclude<Kind, "unsupported">, string> = {
  "win-installed": "会关闭 sikeoop 并打开卸载程序。",
  "win-portable": "便携版没有安装到系统里：sikeoop 会关闭并打开它所在的文件夹，把那个 exe 删掉就卸载完了。",
  mac: "会关闭 sikeoop 并把它移到废纸篓。",
};

/** Asks, then removes the app. Resolves with a message when nothing was done, or never (the app quits). */
export async function uninstall(win: BrowserWindow | null): Promise<string> {
  const k = kind();
  if (k === "unsupported") return app.isPackaged ? "这个版本没有找到卸载程序，请在系统的「应用」里卸载。" : "开发模式下没有东西可卸载。";
  const userData = app.getPath("userData");
  const options = {
    type: "warning" as const,
    title: "卸载 sikeoop",
    message: "要卸载 sikeoop 吗？",
    detail: `${WHAT[k]}\n\n你的项目文件夹不会被动到。`,
    buttons: ["卸载", "取消"],
    defaultId: 1,
    cancelId: 1,
    checkboxLabel: `同时删除我的数据（对话、设置、保存的密钥）${process.platform === "darwin" ? "，移到废纸篓" : "，删了找不回来"}`,
    checkboxChecked: false,
  };
  const answer = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (answer.response !== 0) return "";
  const removeData = answer.checkboxChecked;

  if (k === "mac") {
    try {
      await shell.trashItem(macBundle()!);
    } catch (err) {
      return `没能把 sikeoop 移到废纸篓（${(err as Error).message}）。如果它是从安装镜像里直接打开的，把镜像推出即可；否则请在「应用程序」里手动删除。`;
    }
    if (removeData) await shell.trashItem(userData).catch(() => {});
  } else {
    // The data folder is in use until the app is gone: it is removed a few seconds after it quits.
    if (removeData) {
      spawn("cmd.exe", ["/d", "/s", "/c", `"ping -n 6 127.0.0.1 >nul & rmdir /s /q "${userData}""`], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).unref();
    }
    if (k === "win-installed") spawn(uninstallerPath(), [], { detached: true, stdio: "ignore" }).unref();
    else shell.showItemInFolder(process.env.PORTABLE_EXECUTABLE_FILE!);
  }
  // exit, not quit: nothing is saved back into a data folder that was just removed.
  app.exit(0);
  return "";
}
