// Self-written ACP stdio child. No Electron, SDK, network, or real agent.
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
const log = process.argv[2];
const behavior = process.argv[3] ?? '';
const record = event => appendFileSync(log, JSON.stringify(event) + '\n');
record({ pid: process.pid, cwd: process.cwd(), config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT), leaked: process.env.OPENAI_API_KEY ?? null });
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const reply = (id, result) => send({ id, result });
const update = update => send({ method: 'session/update', params: { sessionId: 'fake-session', update } });
let promptId;
let task;
if (behavior === 'ignore-cancel') process.on('SIGTERM', () => {});
const finish = option => {
  if (task === 'files') {
    writeFileSync(path.join(process.cwd(), 'created.txt'), 'created by fake agent');
    writeFileSync(path.join(process.cwd(), 'changed.txt'), 'changed content now');
    unlinkSync(path.join(process.cwd(), 'deleted.txt'));
  }
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(option) } });
  reply(promptId, { stopReason: task === 'limit' ? 'max_tokens' : 'end_turn' });
};
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); record(m);
  if (m.method === 'initialize') {
    if (behavior === 'handshake-crash') return process.exit(9);
    if (behavior === 'handshake-hang') return;
    if (behavior === 'malformed') return process.stdout.write('bad json\n');
    reply(m.id, { protocolVersion: 1, agentCapabilities: {} });
  } else if (m.method === 'session/new') reply(m.id, { sessionId: 'fake-session', modes: { currentModeId: 'build', availableModes: [{ id: 'plan', name: 'Plan' }] } });
  else if (m.method === 'session/set_mode') {
    if (behavior === 'no-plan') return send({ id: m.id, error: { code: -32601, message: 'unsupported plan' } });
    reply(m.id, {});
  } else if (m.method === 'session/prompt') {
    promptId = m.id; task = m.params.prompt[0].text;
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read file', kind: 'read', status: 'pending' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' });
    if (task === 'crash') return process.exit(17);
    if (task === 'disconnect') return process.stdout.end();
    if (task === 'cancel') return;
    if (task.startsWith('permission')) return send({ id: 'permission-opaque', method: 'session/request_permission', params: { sessionId: 'fake-session', toolCall: { toolCallId: 'tool-1', title: '原始权限标题', kind: task === 'permission-edit' ? 'edit' : 'read', locations: [{ path: '/outside/blocked.txt' }], rawInput: { path: 'file.txt' } }, options: [
      { optionId: 'opaque:once', kind: 'allow_once', name: '只这一次', extra: { v: 1 } },
      { optionId: 'opaque:forever', kind: 'allow_always', name: '一直允许' },
      { optionId: 'opaque:no', kind: 'reject_once', name: '拒绝' },
    ] } });
    finish(null);
  } else if (m.method === 'session/cancel') {
    if (behavior !== 'ignore-cancel') reply(promptId, { stopReason: 'cancelled' });
  } else if (m.id === 'permission-opaque' && m.result) finish(m.result);
  else if (m.method) send({ id: m.id, error: { code: -32601, message: 'unexpected' } });
});
