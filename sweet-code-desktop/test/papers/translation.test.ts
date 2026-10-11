import test from 'node:test';
import assert from 'node:assert/strict';
import type { PaperDoc, PaperTranslation } from '../../src/shared/types.ts';
import { resumeTranslation } from '../../src/main/papers/translation.ts';
const paper: PaperDoc = { id: 'paper', title: 'Sample', authors: [], source: {kind:'file',path:'sample.pdf'}, pages:2, addedAt:0, sections:[
  {id:'s1',title:'Abstract',page:1,text:'First source.'},
  {id:'s2',title:'Methods',page:1,text:'Second source.'},
  {id:'s3',title:'Results',page:2,text:'Third source.'},
  {id:'s4',title:'Discussion',page:2,text:'Fourth source.'},
  {id:'s5',title:'References',page:2,text:'A reference.'},
] };
test('同语言保留完成译文，失败/running/queued 块重新排队且清除旧错误',()=>{
  const previous: PaperTranslation = {lang:'zh',chunks:paper.sections.slice(0,4).map((s,i)=>({sectionId:s.id,source:s.text,status:(['done','failed','running','queued'] as const)[i],text:i===0?'已完成译文':'旧残缺输出',error:'旧错误'}))};
  const result=resumeTranslation(paper,'zh',previous);
  assert.equal(result.chunks.length,4);
  assert.deepEqual(result.chunks[0],{sectionId:'s1',source:'First source.',text:'已完成译文',status:'done'});
  assert.ok(result.chunks.slice(1).every(c=>c.status==='queued' && c.text===undefined && c.error===undefined));
  assert.equal(previous.chunks[1].status,'failed');
});
test('不同语言不得复用完成结果',()=>{
  const previous=resumeTranslation(paper,'zh');previous.chunks.forEach(c=>{c.status='done';c.text='中文';});
  assert.ok(resumeTranslation(paper,'en',previous).chunks.every(c=>c.status==='queued'));
});
test('源文变化或空的完成译文需要重译',()=>{
  const previous: PaperTranslation={lang:'zh',chunks:[{sectionId:'s1',source:'old source',status:'done',text:'旧译文'},{sectionId:'s2',source:'Second source.',status:'done',text:' '}]};
  assert.ok(resumeTranslation(paper,'zh',previous).chunks.every(c=>c.status==='queued'));
});
test('全完成时无待调度块；重复正文按原节和块逐一匹配',()=>{
  const previous=resumeTranslation(paper,'zh');previous.chunks.forEach(c=>{c.status='done';c.text='译文';});
  assert.equal(resumeTranslation(paper,'zh',previous).chunks.filter(c=>c.status!=='done').length,0);
});
