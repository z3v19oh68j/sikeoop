import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { GroupChat, GroupEvent, GroupMember, GroupMessage, GroupSummary } from "@shared/types";
import type { RagService } from "../rag/service";
import { ModelExecutor } from "../dispatch/model.ts";
import type { ModelOutcome } from "../dispatch/model.ts";
import type { Dispatcher } from "../dispatch/scheduler.ts";

// Group chat: several AI members (each a provider × model) talk with the user in one thread.
// Members only read: they see the shared conversation plus code the index finds for the latest
// message, and never touch files; acting on a conclusion is handed to the main Agent chat.
// Chats are saved per project.
//
// Every reply is a job on the dispatch core (a `model` executor). The replies to one message form
// one tree: the first speaker's job is its root, the others hang under it, so stopping the root
// stops them all. The group's id is the jobs' lane: within a group one member speaks at a time, in
// order, each reading what the ones before said; different groups talk at the same time.

/** One streamed model call: system + user → text. */
export type MemberCall = (
  member: GroupMember,
  system: string,
  user: string,
  onDelta: (t: string) => void,
  signal: AbortSignal,
) => Promise<string>;

const MAX_MEMBERS = 8;
/** How much of the conversation each member reads before replying. */
const HISTORY_MESSAGES = 40;
const HISTORY_CHARS = 24_000;

export interface GroupServiceOptions {
  dir: string;
  root(): string | null;
  rag: Pick<RagService, "current">;
  call: MemberCall;
  dispatcher: Pick<Dispatcher, "submit" | "cancel">;
  emit(e: GroupEvent): void;
}

/** The replies to one message of the user's, while they are being written. */
interface Turn {
  /** The first speaker's job: cancelling it cancels the rest. Unset until it is handed out. */
  rootId?: string;
  /** Stops the part before any job exists (looking up code). */
  controller: AbortController;
}

export class GroupService {
  private readonly opts: GroupServiceOptions;
  /** Groups being answered right now, by group id. */
  private readonly turns = new Map<string, Turn>();

  // No parameter properties: the tests run this file under Node's type stripping.
  constructor(opts: GroupServiceOptions) {
    this.opts = opts;
  }

  private folder(): string {
    const root = this.opts.root();
    return path.join(this.opts.dir, root ? createHash("sha256").update(root).digest("hex").slice(0, 16) : "global");
  }

  private file(id: string): string {
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("Invalid group id");
    return path.join(this.folder(), `${id}.json`);
  }

  async list(): Promise<GroupSummary[]> {
    let names: string[];
    try {
      names = (await fs.readdir(this.folder())).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: GroupSummary[] = [];
    for (const n of names) {
      try {
        const g = JSON.parse(await fs.readFile(path.join(this.folder(), n), "utf8")) as GroupChat;
        out.push({ id: g.id, title: g.title, members: g.members, updatedAt: g.updatedAt });
      } catch {
        // Skip a damaged file.
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<GroupChat> {
    return JSON.parse(await fs.readFile(this.file(id), "utf8")) as GroupChat;
  }

  async create(title: string, members: Omit<GroupMember, "id">[]): Promise<GroupChat> {
    if (members.length < 2) throw new Error("群聊至少要 2 位成员");
    if (members.length > MAX_MEMBERS) throw new Error(`群聊最多 ${MAX_MEMBERS} 位成员`);
    const g: GroupChat = {
      id: randomUUID(),
      title: title.trim().slice(0, 40) || "新群聊",
      members: members.map((m) => ({ ...m, name: m.name.trim().slice(0, 24) || m.model, id: randomUUID().slice(0, 8) })),
      messages: [],
      updatedAt: Date.now(),
    };
    await this.save(g);
    return g;
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.file(id), { force: true });
  }

  /** Stops the replies being written in a group: its current tree, speaker and waiting ones alike. Without an id, in every group. */
  stop(id?: string): void {
    for (const [groupId, turn] of this.turns) {
      if (id && groupId !== id) continue;
      turn.controller.abort();
      if (turn.rootId) this.opts.dispatcher.cancel(turn.rootId);
    }
  }

  /** Adds the user's message, then lets the mentioned members (or all, in order) reply. */
  async send(id: string, text: string, mentions: string[]): Promise<void> {
    if (this.turns.has(id)) throw new Error("群里还有人在说话，等一下或者先点停下");
    const turn: Turn = { controller: new AbortController() };
    // Taken before anything is awaited, so a second send to the same group can't slip in.
    this.turns.set(id, turn);
    // "idle" closes a turn that began: an empty message, or a group that can't be read, never began one.
    let began = false;
    try {
      const g = await this.load(id);
      const body = text.trim();
      if (!body) return;
      began = true;
      const msg: GroupMessage = { id: randomUUID(), from: "user", text: body.slice(0, 20_000), at: Date.now() };
      g.messages.push(msg);
      await this.save(g);
      this.opts.emit({ type: "message", groupId: g.id, message: msg });

      const speakers = mentions.length ? g.members.filter((m) => mentions.includes(m.id)) : g.members;
      const code = await this.codeFor(body, turn.controller.signal);
      if (turn.controller.signal.aborted) return;
      // All handed out at once: the lane runs them one after another, in this order.
      const replies: Promise<unknown>[] = [];
      for (const m of speakers) {
        const sub = this.opts.dispatcher.submit({
          executor: this.speaker(g, m, code),
          input: msg.text,
          origin: "user",
          from: "用户",
          parentId: turn.rootId,
          lane: `group:${g.id}`,
        });
        // The tree's budget ran out (more speakers than it allows): the rest don't speak.
        if ("error" in sub) break;
        turn.rootId ??= sub.job.id;
        replies.push(sub.done);
      }
      await Promise.all(replies);
    } finally {
      this.turns.delete(id);
      if (began) this.opts.emit({ type: "idle", groupId: id });
    }
  }

  /** One member's reply as a `model` executor: it announces itself, streams, and puts the reply in the chat. */
  private speaker(g: GroupChat, m: GroupMember, code: string): ModelExecutor {
    const messageId = randomUUID();
    return new ModelExecutor(`group:${g.id}:${m.id}`, m.name, {
      begin: () => this.opts.emit({ type: "speaking", groupId: g.id, memberId: m.id, messageId }),
      // The prompt is written when the member's turn comes, so it holds what was said just before.
      stream: (_job, onDelta, signal) => {
        const { system, user } = prompt(g, m, code);
        return this.opts.call(m, system, user, onDelta, signal);
      },
      delta: (_job, piece) => this.opts.emit({ type: "delta", groupId: g.id, messageId, text: piece }),
      settle: (_job, outcome) => this.said(g, m, messageId, outcome),
    });
  }

  /** A member's reply is over, whole or cut short: it goes into the chat. */
  private async said(g: GroupChat, m: GroupMember, messageId: string, outcome: ModelOutcome): Promise<void> {
    const text = outcome.text;
    const error = outcome.aborted
      ? outcome.aborted === "timeout" ? "等太久了，已停下" : "已停下"
      : outcome.error !== undefined ? outcome.error.slice(0, 300) : text ? undefined : "没有返回内容";
    const msg: GroupMessage = { id: messageId, from: "member", memberId: m.id, text, at: Date.now(), ...(error ? { error } : {}) };
    // Partial text from a stop is kept: it was said.
    if (!text && outcome.aborted) return void this.opts.emit({ type: "message", groupId: g.id, message: msg });
    g.messages.push(msg);
    await this.save(g);
    this.opts.emit({ type: "message", groupId: g.id, message: msg });
  }

  /** Code the index finds for the latest message, shared by every member's reply. */
  private async codeFor(query: string, signal: AbortSignal): Promise<string> {
    const index = this.opts.rag.current();
    if (!index) return "";
    const hits = await index.search(query.slice(0, 2000), 6, { signal }).catch(() => []);
    return hits.map((h) => `## ${h.chunk.path}:${h.chunk.start}-${h.chunk.end}\n\`\`\`\n${h.chunk.text.slice(0, 3000)}\n\`\`\``).join("\n\n");
  }

  private async save(g: GroupChat): Promise<void> {
    g.updatedAt = Date.now();
    const target = this.file(g.id);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(g), "utf8");
    await fs.rename(tmp, target);
  }
}

/** What a member is told and shown when its turn comes. */
function prompt(g: GroupChat, m: GroupMember, code: string): { system: string; user: string } {
  const others = g.members.filter((x) => x.id !== m.id).map((x) => `${x.name}（${x.model}）`);
  const system = `你是「${m.name}」（模型：${m.model}），在一个软件开发群聊里。群里还有：${others.join("、")}，以及项目负责人（用户）。
- 用中文，简洁直接，像在群里说话一样，一般不超过 300 字。
- 先看前面别人说过什么：不要重复，可以赞同、反驳或补充，并点名回应（例如「同意米朵说的……」）。
- 你只能看和讨论，不能修改文件或运行命令；需要动手时，建议用户把结论交给 Agent 去做。
- 提到代码时用完整路径链接，例如 [loop.ts](src/main/agent/loop.ts:42)；没看到的代码不要编造。`;
  const user = `${code ? `# 和最新问题相关的项目代码（来自代码索引）\n${code}\n\n` : ""}# 群聊记录\n${transcript(g)}\n\n现在轮到你（${m.name}）发言。只输出你要说的话，不要带名字前缀。`;
  return { system, user };
}

/** The recent conversation as lines everyone reads, newest last, within the size limit. */
function transcript(g: GroupChat): string {
  const names = new Map(g.members.map((m) => [m.id, m.name]));
  const lines: string[] = [];
  let size = 0;
  for (const msg of g.messages.slice(-HISTORY_MESSAGES).reverse()) {
    if (!msg.text) continue;
    const who = msg.from === "user" ? "用户" : (names.get(msg.memberId ?? "") ?? "成员");
    const line = `[${who}]：${msg.text}`;
    if (size + line.length > HISTORY_CHARS) break;
    size += line.length;
    lines.push(line);
  }
  return lines.reverse().join("\n\n");
}
