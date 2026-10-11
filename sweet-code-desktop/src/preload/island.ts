import { contextBridge, ipcRenderer } from "electron";
import type { IslandApi, IslandLayout, IslandState } from "@shared/types";

// The island window's only door to the system: receive its state, report hover and clicks.
const api: IslandApi = {
  onState: (cb) => {
    const listener = (_e: unknown, s: IslandState) => cb(s);
    ipcRenderer.on("island:state", listener);
    return () => ipcRenderer.removeListener("island:state", listener);
  },
  onLayout: (cb) => {
    const listener = (_e: unknown, l: IslandLayout) => cb(l);
    ipcRenderer.on("island:layout", listener);
    return () => ipcRenderer.removeListener("island:layout", listener);
  },
  hover: (over) => ipcRenderer.send("island:hover", over),
  open: () => ipcRenderer.send("island:open"),
  settled: () => ipcRenderer.send("island:settled"),
  decide: (id, approve) => ipcRenderer.send("island:decide", id, approve),
  selectAgentPermission: (id, optionId) => ipcRenderer.send("island:agentPermission", id, optionId),
  shotAsk: (q) => ipcRenderer.send("island:shotAsk", q),
  shotClose: () => ipcRenderer.send("island:shotClose"),
  shotCopy: () => ipcRenderer.send("island:shotCopy"),
  shotToChat: () => ipcRenderer.send("island:shotToChat"),
  procs: (open, sort) => ipcRenderer.send("island:procs", open, sort),
  focusAgent: (id) => ipcRenderer.send("island:focusAgent", id),
  voice: (action) => ipcRenderer.send("island:voice", action),
  voiceAudio: (audio, mime, error) => ipcRenderer.send("island:voiceAudio", audio, mime, error),
};

contextBridge.exposeInMainWorld("island", api);
