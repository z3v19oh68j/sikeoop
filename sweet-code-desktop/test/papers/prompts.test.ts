import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePromptPack } from '../../src/main/papers/prompt-parser.ts';
import { builtins } from '../../src/main/papers/prompts.ts';
test('自编 Python 样例解析普通/raw/三引号/相邻拼接/加号/转义',()=>{const source=String.raw`def local_catalog():
    return {
      "演示一": {"Prefix": "前缀\n" + "第二行", "Suffix": r"\cite{demo}"},
      "演示二": {"Prefix": ('''多行
原文''' "尾部"), "Suffix": "\u4e2d\x41\101"},
      '演示三': {'Prefix': r'''raw\path''', 'Suffix': ''},
    }`;
const presets=parsePromptPack(source);assert.equal(presets.length,3);assert.equal(presets[0].prefix,'前缀\n第二行');assert.equal(presets[0].suffix,'\\cite{demo}');assert.equal(presets[1].prefix,'多行\n原文尾部');assert.equal(presets[1].suffix,'中AA');assert.equal(presets[2].prefix,'raw\\path');assert.ok(presets.every(p=>p.origin==='gpt_academic'));});
test('非字面量值、f-string、函数调用不执行且跳过',()=>{const source=String.raw`catalog = {
 'dynamic': {'Prefix': read_secret(), 'Suffix': ''},
 'suffix-call': {'Prefix': 'ok', 'Suffix': lookup()},
 'formatted': {'Prefix': f'{secret}', 'Suffix': ''},
 'bytes': {'Prefix': b'hello'},
 'literal': {'Prefix': 'safe'},
}`;const p=parsePromptPack(source);assert.equal(p.length,1);assert.equal(p[0].name,'literal');});
test('注释与字符串里的括号、花括号不破坏结构',()=>{const p=parsePromptPack(`x={'a':{'Prefix':') } # text', # ignored\n 'Suffix':'('},'b':{'Prefix':"x"}}`);assert.equal(p.length,2);assert.equal(p[0].prefix,') } # text');});
test('内置预设覆盖八项写作功能且均为自行编写来源',()=>{assert.equal(builtins.length,8);assert.ok(builtins.every(p=>p.origin==='sikeoop'));assert.equal(new Set(builtins.map(p=>p.action)).size,8);});

test('presetId 的正文严格按 prefix + text + suffix，不混入 action 提示词',async()=>{
  const { writingInput }=await import('../../src/main/papers/prompts.ts');
  const preset={id:'user:sample',name:'Sample',prefix:'<前缀>',suffix:'<后缀>',origin:'user' as const};
  for(const action of ['proofread','expand','title_abstract'] as const) assert.equal(writingInput({action,text:'正文',format:'latex',presetId:preset.id},preset),'<前缀>正文<后缀>');
  assert.match(writingInput({action:'proofread',text:'正文',format:'plain'}),/主要修改/);
});
