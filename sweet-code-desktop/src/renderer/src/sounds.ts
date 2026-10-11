import type { SoundName } from "@shared/types";

// Sound effects (Kenney "Interface Sounds", CC0; see public/sounds/CREDITS.txt). The main process
// decides when something deserves a sound; this window plays it, even while hidden in the tray.

const KEY = "sweet:sound";

export interface SoundSettings {
  enabled: boolean;
  /** 0–1. */
  volume: number;
}

const DEFAULTS: SoundSettings = { enabled: true, volume: 0.6 };
/** Frequent sounds sit lower in the mix. */
const GAIN: Partial<Record<SoundName, number>> = { group: 0.5 };

export function loadSoundSettings(): SoundSettings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<SoundSettings>) };
  } catch {
    return DEFAULTS;
  }
}

export function saveSoundSettings(s: SoundSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not remembered this time.
  }
}

/** When each sound last played, so a burst of events makes one sound, not a pile. */
const last = new Map<SoundName, number>();

export function playSound(name: SoundName, force = false): void {
  const s = loadSoundSettings();
  if (!force && !s.enabled) return;
  const now = Date.now();
  if (!force && now - (last.get(name) ?? 0) < 400) return;
  last.set(name, now);
  const a = new Audio(`sounds/${name}.wav`);
  a.volume = Math.max(0, Math.min(1, s.volume * (GAIN[name] ?? 1)));
  void a.play().catch(() => {
    // No audio device, or the system blocked it: stay silent.
  });
}
