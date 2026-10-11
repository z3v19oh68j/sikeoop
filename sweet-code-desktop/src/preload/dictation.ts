import { contextBridge, ipcRenderer } from "electron";
import type { DictationApi, DictationState } from "@shared/types";

// The dictation bubble's only door to the system: follow the state, hand over the recording.
const api: DictationApi = {
  onState: (cb) => {
    const listener = (_e: unknown, s: DictationState) => cb(s);
    ipcRenderer.on("dict:state", listener);
    return () => ipcRenderer.removeListener("dict:state", listener);
  },
  audio: (wav, error) => ipcRenderer.send("dict:audio", wav, error),
};

contextBridge.exposeInMainWorld("dictation", api);
