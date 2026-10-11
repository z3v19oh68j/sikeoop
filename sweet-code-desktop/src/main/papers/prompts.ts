import type { PromptPreset, WritingAction, WritingRequest } from '../../shared/types.ts';
export const writingInstructions: Record<WritingAction,string> = {
  polish_zh: '将下文润色为准确、自然的中文学术表达，改善逻辑衔接，保留研究事实、数值和不确定性，不添加未提供的证据。',
  polish_en: '将下文润色为清晰、严谨的英文学术表达，减少含混与冗余，不改变研究事实、数值或结论强度。',
  proofread: '检查语法、拼写、标点和术语一致性。返回修改后的完整全文，不能只返回片段；notes 中列出主要修改，不进行无依据的内容扩写。',
  translate_zh_en: '将中文译成英文学术文本，准确传达术语、条件和否定，不省略段落。',
  translate_en_zh: '将英文译成中文学术文本，术语准确，保留限定条件和论证关系，不省略段落。',
  shorten: '精简下文，删除重复表述，保留核心论点、方法、数据及必要限制；不改变原意。',
  expand: '扩展下文的逻辑说明与段落衔接，不编造数据、实验、引用或结论；缺失信息明确说明。',
  title_abstract: '根据下文生成准确的论文标题与摘要，摘要包含研究问题、方法和已提供的结果；不虚构效果或实验。',
};
export const builtins: PromptPreset[] = Object.entries(writingInstructions).map(([action,prefix]) => ({id:`sikeoop:${action}`,name:({polish_zh:'中文学术润色',polish_en:'英文学术润色',proofread:'语法与拼写纠错',translate_zh_en:'中译英',translate_en_zh:'英译中',shorten:'精简',expand:'扩展',title_abstract:'标题与摘要'} as Record<string,string>)[action], action:action as WritingAction, prefix:prefix+'\n',suffix:'',origin:'sikeoop'}));

/** A preset entirely replaces the action's instruction; format/output constraints remain global. */
export function writingInput(req: WritingRequest, preset?: PromptPreset): string {
  // An extra requirement for this run (a reviewer's comment to answer) goes right before the text.
  const note = req.note?.trim() ? `\n（这次的额外要求：${req.note.trim()}）\n` : '';
  return preset ? preset.prefix + note + req.text + preset.suffix : writingInstructions[req.action] + note + '\n' + req.text;
}
