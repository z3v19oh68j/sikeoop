import type { AutomationSchedule } from "@shared/types";

/** Shortest interval allowed: anything faster would spend tokens faster than anyone can read the results. */
export const MIN_INTERVAL_MINUTES = 5;

/** The first time after `from` the schedule fires, or null when it never will again. */
export function nextRun(s: AutomationSchedule, from: number): number | null {
  switch (s.kind) {
    case "manual":
      return null;
    case "once":
      return s.at > from ? s.at : null;
    case "interval":
      return from + Math.max(MIN_INTERVAL_MINUTES, s.minutes) * 60_000;
    case "daily": {
      const hm = parseTime(s.time);
      if (!hm) return null;
      // Day by day from today: the clock time is set on each day, so DST changes keep the wall time.
      for (let i = 0; i <= 7; i++) {
        const d = new Date(from);
        d.setDate(d.getDate() + i);
        d.setHours(hm[0], hm[1], 0, 0);
        if (d.getTime() > from && (s.days.length === 0 || s.days.includes(d.getDay()))) return d.getTime();
      }
      return null;
    }
  }
}

/** "9:05" / "09:05" → [9, 5]; null when it isn't a time of day. */
export function parseTime(t: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? [h, min] : null;
}

/** Why the schedule can't be saved, or "". */
export function scheduleProblem(s: AutomationSchedule): string {
  if (s.kind === "interval" && !(Number.isFinite(s.minutes) && s.minutes >= MIN_INTERVAL_MINUTES)) {
    return `间隔至少 ${MIN_INTERVAL_MINUTES} 分钟`;
  }
  if (s.kind === "daily") {
    if (!parseTime(s.time)) return "时间要写成 09:30 这样";
    if (s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "星期几不对";
  }
  if (s.kind === "once" && !(Number.isFinite(s.at) && s.at > Date.now())) return "运行时间要在将来";
  return "";
}
