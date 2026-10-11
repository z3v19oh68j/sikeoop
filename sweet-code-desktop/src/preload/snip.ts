import { contextBridge, ipcRenderer } from "electron";
import type { SnipApi } from "@shared/types";

// The screenshot overlay: receives the frozen screen, reports the chosen area.
const api: SnipApi = {
  onImage: (cb) => {
    const listener = (_e: unknown, dataUrl: string) => cb(dataUrl);
    ipcRenderer.on("snip:image", listener);
    return () => ipcRenderer.removeListener("snip:image", listener);
  },
  done: (rect) => ipcRenderer.send("snip:done", rect),
};

contextBridge.exposeInMainWorld("snip", api);
