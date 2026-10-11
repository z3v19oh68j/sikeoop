// Notices when the user starts a coding CLI by hand in a shell tab ("opencode", "claude"…). Run
// that way sikeoop can't see it: it isn't on the island and other agents can't message it, so the
// panel suggests the "+" menu instead. Only what was typed is looked at, key by key; a line the
// shell built itself (history, tab completion) is not guessed at. No imports: tested under node.

/** The keys typed on the current line so far. `unsure`: the shell changed the line in a way we can't follow. */
export interface TypedLine {
  text: string;
  unsure: boolean;
}

export const emptyLine = (): TypedLine => ({ text: "", unsure: false });

/** Feeds what xterm sends for the user's keys (or a paste). Returns the lines that were entered, in order. */
export function typeInto(line: TypedLine, data: string): { line: TypedLine; entered: string[] } {
  let { text, unsure } = line;
  const entered: string[] = [];
  // A paste arrives wrapped in bracketed-paste markers; its text counts as typed.
  const keys = data.replace(/\x1b\[20[01]~/g, "");
  for (let i = 0; i < keys.length; i++) {
    const c = keys[i];
    if (c === "\r" || c === "\n") {
      if (!unsure && text.trim()) entered.push(text.trim());
      text = "";
      unsure = false;
    } else if (c === "\x7f" || c === "\b") text = text.slice(0, -1);
    else if (c === "\x03" || c === "\x15") {
      // Ctrl-C, Ctrl-U: the line is gone.
      text = "";
      unsure = false;
    } else if (c < " ") {
      // Arrows, history, completion, other control keys: what the line holds now is the shell's business.
      unsure = true;
      // The rest of an escape sequence is not text.
      if (c === "\x1b") while (i + 1 < keys.length && !/[A-Za-z~]/.test(keys[i])) i++;
    } else text += c;
  }
  return { line: { text, unsure }, entered };
}

/**
 * The CLI an entered command line starts as an interactive session, by executable name, or null.
 * `claude --version`, `opencode auth login`, `codex exec …` are not sessions and are let be.
 */
export function startsCli<T extends { bins?: string[] }>(command: string, kinds: T[]): T | null {
  // Only a plain command: anything piped, chained or substituted is the user's own script.
  if (/[|&;<>`$(]/.test(command)) return null;
  const words = command.split(/\s+/).filter(Boolean);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  if (!words.length) return null;
  const bin = words[0].split("/").pop()!;
  const kind = kinds.find((k) => k.bins?.includes(bin));
  if (!kind) return null;
  const args = words.slice(1);
  if (args.some((a) => /^(-v|--version|-h|--help|-p|--print)$/.test(a))) return null;
  // A bare word right after it is a subcommand (auth, mcp, run, login…), not a session.
  if (args.length && /^[a-z][a-z-]*$/.test(args[0])) return null;
  return kind;
}
