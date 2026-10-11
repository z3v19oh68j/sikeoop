export function repositoryRecords(data: unknown): Record<string, unknown>[] {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    const array = ['items', 'evidence', 'ccma_repository_items', 'repository_items', 'claims'].map(k => o[k]).find(Array.isArray);
    data = array ?? (['ref', 'title', 'detail'].some(k => k in o) ? [o] : data);
  }
  if (!Array.isArray(data) || data.some(v => !v || typeof v !== 'object' || Array.isArray(v))) throw new Error('证据库需要是记录数组，或包含 items、evidence、claims 等记录数组的 JSON');
  return data as Record<string, unknown>[];
}

export function repositoryRefs(data: unknown): string[] {
  return repositoryRecords(data).flatMap(item => {
    if (Array.isArray(item.claims) && item.claims.length) {
      if (item.claims.some(c => !c || typeof c !== 'object' || Array.isArray(c))) throw new Error('证据库的 claims 必须是对象数组');
      // Python assigns random repo ids to missing refs: these cannot be predicted.
      if (!('ref' in item)) return [];
      return item.claims.map((_, i) => `${String(item.ref)}/claim_${i + 1}`);
    }
    return [String(item.ref ?? '')];
  });
}
