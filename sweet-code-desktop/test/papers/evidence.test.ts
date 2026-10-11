import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeEvidence, mergeEvidence, normalizeEvidence, safeName } from '../../src/main/papers/evidence.ts';
const quote={paperId:'paper',sectionId:'s2',page:3,excerpt:'Original statement.'};
test('证据库纯格式去掉 quote，旁车可合并恢复',()=>{const record={ref:'arxiv:2401.12345',title:'Paper',detail:'Result',source:'论文工坊',claims:[{title:'Claim',detail:'Data',quote}]};const data=serializeEvidence([record]);assert.ok(!JSON.stringify(data.repository).includes('quote'));assert.deepEqual(Object.keys(data.repository[0]).sort(),['claims','detail','ref','source','title']);assert.deepEqual(mergeEvidence(data.repository,data.quotes),[record]);});
test('论文及论点 title/detail 截断 200/500 Unicode 字符',()=>{const r=serializeEvidence([{ref:'ref',title:'😀'.repeat(250),detail:'文'.repeat(600),source:'x',claims:[{title:'t'.repeat(300),detail:'d'.repeat(800)}]}]).repository[0];assert.equal(Array.from(r.title).length,200);assert.equal(r.detail.length,500);assert.equal(r.claims[0].title.length,200);assert.equal(r.claims[0].detail.length,500);});
test('拒绝不合法证据与旁车定位',()=>{assert.throws(()=>normalizeEvidence({}));assert.throws(()=>normalizeEvidence([{ref:'r',title:'t',detail:'d',source:'s',claims:[{title:'a',detail:'b',quote:{...quote,page:0}}]}]));});
test('文件名清洗不可留下路径穿越',()=>{assert.equal(safeName('../../a:b'),'_.._a_b');assert.throws(()=>safeName('...'));assert.throws(()=>safeName('CON'));assert.ok(!safeName('x/y\\z').includes('/'));});
