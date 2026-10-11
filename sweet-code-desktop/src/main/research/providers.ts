import type { CcProvider, ResearchCandidate, ResearchRequest } from '../../shared/types.ts';
import { PRESETS } from '../providers/presets.ts';

export interface ProviderSource {
  exists(id: string): boolean;
  resolve(id: string): { preset: { id: string; name: string }; baseURL: string; model: string; apiKey: string; authMode: string };
}
export const PROVIDER_MAP: Record<string, CcProvider> = {
  anthropic: 'anthropic', openai: 'openai', deepseek: 'deepseek', minimax: 'minimax', moonshot: 'kimi', zhipu: 'glm', 'mimo-api': 'mimo', doubao: 'doubao', qwen: 'qwen',
};
// Not "mimo" (the Token Plan): its tp- keys and endpoint differ from the API Chain-Centric calls.
export const KEY_ENV: Record<CcProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', minimax: 'MINIMAX_API_KEY', kimi: 'KIMI_API_KEY', glm: 'GLM_API_KEY', mimo: 'MIMO_API_KEY', doubao: 'DOUBAO_API_KEY', qwen: 'QWEN_API_KEY',
};
export function candidate(source: ProviderSource, id: string): ResearchCandidate | null {
  const cc = PROVIDER_MAP[id]; const preset = PRESETS.find(p => p.id === id);
  if (!cc || !preset || !source.exists(id)) return null;
  const r = source.resolve(id);
  if (r.authMode !== 'api_key' || r.baseURL !== preset.baseURL) return null;
  return { providerId: id, providerName: r.preset.name, model: r.model, cc, ready: !!r.apiKey.trim() };
}
export function candidates(source: ProviderSource): ResearchCandidate[] {
  return Object.keys(PROVIDER_MAP).flatMap(id => { const c = candidate(source, id); return c ? [c] : []; });
}
export interface SelectedModel { cc: CcProvider; model: string; key: string; candidate: ResearchCandidate }
export function selectModels(source: ProviderSource, request: ResearchRequest): { agents: SelectedModel[]; evidence: SelectedModel } {
  if (!request || typeof request.question !== 'string' || !request.question.trim() || !Array.isArray(request.agents) || !request.agents.length || request.agents.length > 32 || !Number.isInteger(request.maxRounds) || request.maxRounds < 1 || request.maxRounds > 10000) throw new Error('请填写研究问题、模型和有效的轮数上限');
  const select = (ref: ResearchRequest['evidence']): SelectedModel => {
    if (!ref || typeof ref.providerId !== 'string' || typeof ref.model !== 'string' || !ref.model.trim() || /[,\r\n\x00]/.test(ref.model)) throw new Error('模型名称不正确');
    const c = candidate(source, ref.providerId);
    if (!c) throw new Error('所选服务商不能用于深度科研：需要官方地址和 API Key 登录方式');
    if (!c.ready) throw new Error(`${c.providerName} 还没有配置 API Key，请先到设置里填写`);
    return { cc: c.cc, model: ref.model.trim(), key: source.resolve(ref.providerId).apiKey, candidate: c };
  };
  return { agents: request.agents.map(select), evidence: select(request.evidence) };
}
/** No ambient keys, SDK endpoint overrides, Python injection or dotenv settings. */
export function buildRunEnv(parent: NodeJS.ProcessEnv, home: string, agents: readonly SelectedModel[], evidence: SelectedModel): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Proxies too: behind a proxy set by environment variables the models are unreachable without them.
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']);
  for (const [k, v] of Object.entries(parent)) if (allowed.has(k.toUpperCase())) env[k] = v;
  Object.assign(env, { HOME: home, USERPROFILE: home, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', CHAIN_CENTRIC_AGENTS: agents.map(a => `${a.cc}:${a.model}`).join(','), CHAIN_CENTRIC_EVIDENCE_LLM: `${evidence.cc}:${evidence.model}` });
  for (const m of [...agents, evidence]) env[KEY_ENV[m.cc]] = m.key;
  return env;
}
