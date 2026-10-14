import type { GroupPlan, GroupPlanTask } from "../../shared/types.ts";

// The group's channel to the main conversation. A group talks an idea through; when it has settled,
// one member writes the outcome up as a plan: is it feasible, and who does what. The plan is checked
// here (every task goes to someone who can actually be handed work) and kept with the group. The main
// conversation then gets it as a fixed work order: it hands the tasks out as written and does not
// plan again.

export interface Assignee {
  /** As send_to_agent names it: "provider/model", or a terminal session's name. */
  name: string;
  /** Who that is, for the member writing the plan: "米朵（群成员）", "终端里的 Claude Code"… */
  note: string;
}

const MAX_TASKS = 12;

/** What the member writing the plan is told. */
export function planPrompt(transcript: string, assignees: Assignee[]): { system: string; user: string } {
  const system = `你是群聊的记录员。大家已经讨论过了，现在由你把结论整理成一份分工方案，交给主对话去派活。
- 只整理群里已经说定的内容，不加新主意。没说定的写进 open，不要替大家做决定。
- 先判断可行性：讨论的结论是做不了，就 feasible 填 false，summary 写原因，tasks 留空。
- 每个任务只交给一个人，assignee 必须从下面「可以接活的人」里原样选一个名字。群里已经说好谁做什么，就照说好的填。
- what 要写给没看过讨论的人：目标、相关文件路径、注意事项。owns 填它可以改的文件或文件夹（相对项目根，文件夹以 / 结尾），只读的任务填空数组；两个任务不能改同一个文件。
- after 填必须先做完的任务的 id。accept 写怎么算做完。最多 ${MAX_TASKS} 个任务。
只输出一个 JSON 对象，不要解释，不要代码块标记：
{"goal":"一句话目标","feasible":true,"summary":"结论，两三句","tasks":[{"id":"t1","title":"短标题","assignee":"名字","what":"做什么","owns":["src/a.ts"],"after":[],"accept":"验收标准"}],"open":["还没说定的问题"]}`;
  const who = assignees.map((a) => `- ${a.name}（${a.note}）`).join("\n") || "- （现在没有人可以接活）";
  return { system, user: `# 可以接活的人\n${who}\n\n# 群聊记录\n${transcript}\n\n现在整理成 JSON。` };
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strs = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean) : []);

/** The first JSON object in a reply that may have prose or a code fence around it. */
function jsonIn(text: string): unknown {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("没有整理出方案（回复里没有 JSON）。再点一次，或换一位成员整理。");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("整理出的方案格式不对。再点一次，或换一位成员整理。");
  }
}

/**
 * A member's write-up as a checked plan. Throws, in words for the user, when it can't be handed on:
 * a task for someone who can't take work, two tasks changing the same file, a dependency loop.
 */
export function parsePlan(text: string, assignees: Assignee[], by: string, now = Date.now()): GroupPlan {
  const raw = jsonIn(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("整理出的方案格式不对。再点一次，或换一位成员整理。");
  const o = raw as Record<string, unknown>;
  const names = new Map(assignees.map((a) => [a.name.toLowerCase(), a.name]));
  const list = Array.isArray(o.tasks) ? o.tasks : [];
  if (list.length > MAX_TASKS) throw new Error(`方案里有 ${list.length} 个任务，最多 ${MAX_TASKS} 个。让大家把任务合并一下再整理。`);
  const tasks: GroupPlanTask[] = [];
  const owned = new Map<string, string>();
  for (const [i, item] of list.entries()) {
    const t = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const id = str(t.id, 24) || `t${i + 1}`;
    const title = str(t.title, 80), what = str(t.what, 4000);
    if (!title || !what) throw new Error(`第 ${i + 1} 个任务没写清楚做什么。`);
    if (tasks.some((x) => x.id === id)) throw new Error(`任务编号「${id}」重复了。`);
    const assignee = names.get(str(t.assignee, 120).toLowerCase());
    if (!assignee) throw new Error(`任务「${title}」分给了「${str(t.assignee, 120) || "（没写）"}」，这个名字现在接不了活。可以接活的：${assignees.map((a) => a.name).join("、") || "没有"}。`);
    const owns = strs(t.owns, 200);
    for (const file of owns) {
      const other = owned.get(file);
      if (other) throw new Error(`「${other}」和「${title}」都要改 ${file}。让大家把这个文件归给一个任务再整理。`);
      owned.set(file, title);
    }
    tasks.push({ id, title, assignee, what, owns, after: strs(t.after, 24), accept: str(t.accept, 600) });
  }
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    const unknown = t.after.find((a) => !ids.has(a) || a === t.id);
    if (unknown) throw new Error(`任务「${t.title}」要等「${unknown}」，但没有这个任务。`);
  }
  // Every task must be reachable by doing the ones before it: a loop would never start.
  const done = new Set<string>();
  while (done.size < tasks.length) {
    const next = tasks.filter((t) => !done.has(t.id) && t.after.every((a) => done.has(a)));
    if (!next.length) throw new Error("任务之间互相等待，谁也开始不了。让大家理一下先后顺序再整理。");
    for (const t of next) done.add(t.id);
  }
  const feasible = o.feasible !== false;
  const goal = str(o.goal, 200), summary = str(o.summary, 1500);
  if (!goal) throw new Error("方案里没写目标。再点一次，或换一位成员整理。");
  if (feasible && !tasks.length) throw new Error("方案说可行，但没有分出任务。让大家说清谁做什么再整理。");
  return { goal, feasible, summary, tasks: feasible ? tasks : [], open: strs(o.open, 400).slice(0, 10), by, at: now };
}

/** The plan as the group reads it in the chat. */
export function planMarkdown(plan: GroupPlan): string {
  const head = `**${plan.feasible ? "分工方案" : "结论：不可行"}**：${plan.goal}${plan.summary ? `\n\n${plan.summary}` : ""}`;
  const tasks = plan.tasks.map((t, i) =>
    `${i + 1}. **${t.title}** → ${t.assignee}${t.after.length ? `（等 ${t.after.join("、")}）` : ""}\n   ${t.what.replace(/\n+/g, " ")}${t.owns.length ? `\n   可改：${t.owns.join("、")}` : ""}${t.accept ? `\n   验收：${t.accept}` : ""}`);
  const open = plan.open.length ? `\n\n**还没说定：**\n${plan.open.map((q) => `- ${q}`).join("\n")}` : "";
  return [head, tasks.join("\n")].filter(Boolean).join("\n\n") + open;
}

/** Tasks in the order they can be handed out: each batch only waits on earlier batches. */
export function batches(plan: GroupPlan): GroupPlanTask[][] {
  const out: GroupPlanTask[][] = [];
  const done = new Set<string>();
  while (done.size < plan.tasks.length) {
    const next = plan.tasks.filter((t) => !done.has(t.id) && t.after.every((a) => done.has(a)));
    if (!next.length) break;
    out.push(next);
    for (const t of next) done.add(t.id);
  }
  return out;
}

/**
 * The plan as a work order for the main conversation (sent in super-dispatch mode). The division of
 * work is already decided: the main conversation hands it out and checks what comes back.
 */
export function handoffText(title: string, plan: GroupPlan): string {
  if (!plan.feasible) throw new Error("群里的结论是这件事做不了，没有可以交出去的分工。");
  const order = batches(plan).map((batch, i) =>
    `## 第 ${i + 1} 批（同一批一起派）\n` + batch.map((t) =>
      `- 任务 ${t.id}「${t.title}」\n  - 交给：${t.assignee}\n  - 做什么：${t.what.replace(/\n+/g, " ")}\n  - owns：${t.owns.length ? t.owns.join("、") : "（只读，不改文件）"}${t.accept ? `\n  - 验收：${t.accept}` : ""}`).join("\n")).join("\n\n");
  const open = plan.open.length
    ? `\n\n# 群里还没说定的问题\n${plan.open.map((q) => `- ${q}`).join("\n")}\n这些要先用提问工具问我，我答完再开始派活。`
    : "";
  return `这是群聊「${title}」讨论后定下的分工方案（由 ${plan.by} 整理）。分工已经定好，你只负责按表派活和验收，不要重新规划。

规则：
- 每个任务用 send_to_agent 交给表里写的那个人，to 原样填「交给」里的名字，message 写「做什么」和「验收」，owns 原样填。同一批的任务放进一次 tasks 里一起派；上一批全部回来后再派下一批。
- 不要换人、不要合并或拆分任务、不要增减任务、不要自己动手做。
- 表里的人现在接不了活（不在线、没配置好），就停下来告诉我是哪个任务，不要找别人顶替。
- 回来的结果只看结论和验收。没过的把问题写清楚，交回给同一个人返工一次；还不过就如实告诉我。
- 全部做完后给我一份汇总：每个任务谁做的、改了哪些文件、验收结果、遗留问题。

# 目标
${plan.goal}${plan.summary ? `\n\n# 结论\n${plan.summary}` : ""}

# 分工
${order}${open}`;
}
