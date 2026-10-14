import {test} from "node:test";
import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const packsRoot=path.join(root,"resources/pv-packs");
const skillsRoot=path.join(root,"resources/skills");
const packKinds=["common","promo","music"];
const allowedSteps=["brief","script","storyboard","beats","assets","compose","render"];
const keyPatterns=[/sk-[A-Za-z0-9_-]{20,}/,/api[-_ ]?key\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i];
async function loadDir(kind:string){
  const dir=path.join(packsRoot,kind);
  const files=(await fs.readdir(dir)).filter(f=>f.endsWith(".json")).sort();
  const packs:any[]=[];
  for(const file of files){
    const raw=await fs.readFile(path.join(dir,file),"utf8");
    packs.push({file,pack:JSON.parse(raw),raw});
  }
  return packs;
}
async function listSkills(){
  const names=(await fs.readdir(skillsRoot,{withFileTypes:true})).filter(d=>d.isDirectory()).map(d=>d.name);
  return names.filter(n=>n.startsWith("pv-")||n==="remotion-pv"||n==="ffmpeg-recipes").sort();
}
test("经验包 JSON 可解析，kind、id、name、条目结构合法",async()=>{
  for(const kind of packKinds){
    const packs=await loadDir(kind);
    assert.ok(packs.length>0,`${kind} 目录没有经验包`);
    const ids=new Set<string>();
    for(const {file,pack} of packs){
      const where=`${kind}/${file}`;
      assert.equal(pack.kind,kind,`${where} 的 kind 应为 ${kind}`);
      assert.equal(typeof pack.id,"string",`${where} id 不是字符串`);
      assert.ok(pack.id.trim().length>0,`${where} id 为空`);
      assert.equal(typeof pack.name,"string",`${where} name 不是字符串`);
      assert.ok(pack.name.trim().length>0,`${where} name 为空`);
      assert.ok(!ids.has(pack.id),`${kind} 目录内包 id 重复：${pack.id}`);
      ids.add(pack.id);
      assert.ok(Array.isArray(pack.entries)&&pack.entries.length>0,`${where} entries 为空或不是数组`);
      const entryIds=new Set<string>();
      for(const entry of pack.entries){
        const label=`${where} 条目 ${entry.id}`;
        assert.equal(typeof entry.id,"string",`${label} id 不是字符串`);
        assert.ok(!entryIds.has(entry.id),`${label} 在包内 id 重复`);
        entryIds.add(entry.id);
        assert.ok(typeof entry.title==="string"&&entry.title.trim().length>0,`${label} title 为空`);
        assert.ok(typeof entry.body==="string"&&entry.body.trim().length>0,`${label} body 为空`);
        assert.ok(Array.isArray(entry.steps)&&entry.steps.length>0,`${label} steps 为空`);
        for(const step of entry.steps)assert.ok(allowedSteps.includes(step),`${label} 出现未知步骤：${step}`);
      }
    }
  }
});
test("经验包条目正文不超过 400 字符",async()=>{
  for(const kind of packKinds){
    for(const {file,pack} of await loadDir(kind)){
      for(const entry of pack.entries){
        const len=Array.from(entry.body).length;
        assert.ok(len<=400,`${kind}/${file} 条目 ${entry.id} 正文 ${len} 字符，超过 400`);
      }
    }
  }
});
test("common 和 music 包不出现产品名 sikeoop（不分大小写）",async()=>{
  for(const kind of ["common","music"]){
    for(const {file,raw} of await loadDir(kind)){
      assert.doesNotMatch(raw,/sikeoop/i,`${kind}/${file} 含有产品名 sikeoop`);
    }
  }
});
test("common 和 promo 中含 assets 步骤的条目正文不出现“镜头”",async()=>{
  for(const kind of ["common","promo"]){
    for(const {file,pack} of await loadDir(kind)){
      for(const entry of pack.entries){
        if(!entry.steps.includes("assets"))continue;
        assert.doesNotMatch(entry.body,/镜头/,`${kind}/${file} 条目 ${entry.id} 的 assets 正文含“镜头”`);
      }
    }
  }
});
test("pv- 技能及 remotion-pv、ffmpeg-recipes 有合法的 SKILL.md frontmatter",async()=>{
  const skills=await listSkills();
  for(const required of ["remotion-pv","ffmpeg-recipes"])assert.ok(skills.includes(required),`缺少技能目录 ${required}`);
  for(const name of skills){
    const file=path.join(skillsRoot,name,"SKILL.md");
    const text=await fs.readFile(file,"utf8").catch(()=>null);
    assert.notEqual(text,null,`${name} 缺少 SKILL.md`);
    assert.ok(text!.startsWith("---\n"),`${name}/SKILL.md 开头不是 frontmatter`);
    const end=text!.indexOf("\n---",4);
    assert.ok(end>0,`${name}/SKILL.md frontmatter 没有结束标记`);
    const header=text!.slice(4,end);
    const nameMatch=header.match(/^name:[ \t]*(.+?)[ \t]*$/m);
    const descMatch=header.match(/^description:[ \t]*(.+?)[ \t]*$/m);
    assert.ok(nameMatch,`${name}/SKILL.md frontmatter 缺少 name`);
    assert.equal(nameMatch![1].replace(/^["']|["']$/g,""),name,`${name}/SKILL.md 的 name 与目录名不一致`);
    assert.ok(descMatch&&descMatch[1].replace(/^["']|["']$/g,"").trim().length>0,`${name}/SKILL.md description 为空`);
  }
});
test("经验包和 pv 技能正文不含密钥形态的内容",async()=>{
  const targets:{label:string,text:string}[]=[];
  for(const kind of packKinds){
    for(const {file,raw} of await loadDir(kind))targets.push({label:`${kind}/${file}`,text:raw});
  }
  for(const name of await listSkills()){
    const file=path.join(skillsRoot,name,"SKILL.md");
    targets.push({label:`${name}/SKILL.md`,text:await fs.readFile(file,"utf8").catch(()=>"")});
  }
  for(const {label,text} of targets){
    for(const pattern of keyPatterns)assert.doesNotMatch(text,pattern,`${label} 疑似含有密钥`);
  }
});
