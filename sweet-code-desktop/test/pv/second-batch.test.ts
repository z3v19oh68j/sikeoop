import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PvStep } from "../../src/shared/types.ts";
import { PvStore, parseStoryboard } from "../../src/main/pv/store.ts";
import { PvService, type PvDeps } from "../../src/main/pv/service.ts";
import { FfmpegService } from "../../src/main/pv/ffmpeg.ts";
import { Dispatcher } from "../../src/main/dispatch/scheduler.ts";
import { detectBeats, makeBeatGrid, snapStoryboard, decodeMusic, PCM_RATE } from "../../src/main/pv/beats.ts";
import { assetPath, importAssets, listAssets, validateShotAssets } from "../../src/main/pv/assets.ts";
import { MAX_ASSET_BYTES } from "../../src/main/pv/media.ts";
import { assetUrl, servePvMedia } from "../../src/main/pv/protocol.ts";
import { registerPvIpc } from "../../src/main/pv/ipc.ts";
import { remotionTemplate } from "../../src/main/pv/template.ts";

function clicks(bpm: number, seconds = 16, offset = 0.25, subdivision = false) {
  const samples = new Float32Array(Math.round(seconds * PCM_RATE));
  const hit = (at: number, gain: number) => {
    const start = Math.round(at * PCM_RATE);
    for (let i = 0; i < 160 && start + i < samples.length; i++)
      samples[start + i] += gain * Math.exp(-i / 24) * Math.cos(i * 1.6);
  };
  for (let at = offset; at < seconds; at += 60 / bpm) {
    hit(at, 1);
    if (subdivision) hit(at + 30 / bpm, 0.035);
  }
  return samples;
}
function pcm(samples: Float32Array) {
  const bytes = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) bytes.writeFloatLE(samples[i], i * 4);
  return bytes;
}
const baseShot = { id: "one", seconds: 1.3, framing: "中景", camera: "固定", visual: "测试", source: "code" as const };

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pv-second-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PvStore();
  const project = await store.create(root, { name: "音乐测试", kind: "music", ratio: "16:9", seconds: 16 });
  const put = async (file: string, text = "fixture") => {
    const target = path.join(project.dir, "assets", file);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text); return target;
  };
  return { root, store, project, put };
}
function ffmpegReady(root: string) {
  return new FfmpegService({ userData: root, platform: "darwin", envPath: "/test/bin",
    systemFs: { stat: async () => ({ isFile: () => true }), access: async () => {} },
    request: async () => { throw new Error("No network"); }, run: async () => 0,
    approve: async () => { throw new Error("No download"); }, plan: async () => { throw new Error("No plan"); },
  });
}
async function serviceFixture(t: TestContext, extra: Partial<PvDeps> = {}) {
  const f = await fixture(t);
  const dispatcher = new Dispatcher({ emit() {} });
  t.after(() => dispatcher.close());
  const events: { id: string; step: PvStep; status: string; message?: string }[] = [];
  const calls: string[][] = [];
  const deps: PvDeps = { root: () => f.root, development: () => true, packsDir: path.resolve("resources/pv-packs"), dispatcher,
    ffmpeg: ffmpegReady(f.root), model: async () => { throw new Error("Local steps must not call a model"); },
    compose: async () => "components ready", emit: event => events.push(event),
    run: async (_bin, args) => {
      calls.push(args);
      if (args.includes("f32le")) await fs.writeFile(args.at(-1)!, pcm(clicks(120)));
      else await fs.writeFile(args.at(-1)!, "mock media");
      return 0;
    }, ...extra,
  };
  const pv = new PvService(deps);
  const step = async (name: PvStep) => {
    const previous = events.length;
    const jobId = await pv.runStep(f.root, f.project.id, name);
    for (let i = 0; i < 200; i++) {
      const event = events.slice(previous).find(e => e.step === name && (e.status === "done" || e.status === "error"));
      if (event) return { event, job: dispatcher.jobs().find(j => j.id === jobId)! };
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("Step did not finish");
  };
  return { ...f, pv, events, calls, step, deps };
}

test("纯 JS 起音/自相关识别已知 BPM、非整数周期和起拍，不误取半速", () => {
  for (const bpm of [60, 90, 120, 123, 150, 180]) {
    const result = detectBeats(clicks(bpm), PCM_RATE, "music.wav");
    assert.ok(Math.abs(result.bpm - bpm) < 1, `${bpm}: ${result.bpm}`);
    assert.ok(Math.abs(result.offset - 0.25) < 0.04, `${bpm}: ${result.offset}`);
    assert.equal(result.duration, 16); assert.equal(result.file, "music.wav");
    assert.ok(result.confidence > 0 && result.confidence <= 1);
    assert.ok(result.beats.every((at, i) => at < result.duration && (!i || at > result.beats[i - 1])));
    assert.deepEqual(result.bars, result.beats.filter((_, i) => i % 4 === 0));
  }
  const subdivision = detectBeats(clicks(90, 16, 0.25, true));
  assert.ok(Math.abs(subdivision.bpm - 90) < 1, String(subdivision.bpm));
  const delayed = detectBeats(clicks(120, 16, 1.25));
  assert.ok(Math.abs(delayed.offset - 1.25) < 0.04);
});

test("静音、非有限 PCM、短音频和非法手调网格明确拒绝", () => {
  assert.throws(() => detectBeats(new Float32Array(PCM_RATE * 3)), /未检测/);
  assert.throws(() => detectBeats(new Float32Array(PCM_RATE)), /长度/);
  const corrupt = clicks(120); corrupt[10] = NaN;
  assert.throws(() => detectBeats(corrupt), /PCM/);
  for (const grid of [{ bpm: 0, offset: 0, beatsPerBar: 4 }, { bpm: NaN, offset: 0, beatsPerBar: 4 },
    { bpm: 120, offset: -1, beatsPerBar: 4 }, { bpm: 120, offset: 10, beatsPerBar: 4 },
    { bpm: 120, offset: 0, beatsPerBar: 0 }, { bpm: 120, offset: 0, beatsPerBar: 2.5 }])
    assert.throws(() => makeBeatGrid("a.wav", 10, grid), /网格参数/);
});

test("吸附按最近整数小节/拍取整且至少一个单位，不修改原分镜", () => {
  const beats = makeBeatGrid("a.wav", 10, { bpm: 120, offset: 0.25, beatsPerBar: 4 });
  const sb = parseStoryboard({ shots: [baseShot, { ...baseShot, id: "two", seconds: 0.1 }, { ...baseShot, id: "three", seconds: 3.2 }] });
  const before = structuredClone(sb);
  assert.deepEqual(snapStoryboard(sb, beats, "bar").shots.map(s => s.seconds), [2, 2, 4]);
  assert.deepEqual(snapStoryboard(sb, beats, "beat").shots.map(s => s.seconds), [1.5, 0.5, 3]);
  assert.deepEqual(sb, before);
  assert.throws(() => snapStoryboard(sb, beats, "bad" as "bar"), /单位/);
});

test("素材导入清洗文件名、重名改名、分类和列举，原文件保持不变", async t => {
  const { root, project } = await fixture(t);
  const first = path.join(root, "中文#素材.PNG"), second = path.join(root, "music.MP3");
  await fs.writeFile(first, "image"); await fs.writeFile(second, "audio");
  const imported = await importAssets(root, project.id, [first, second, first]);
  assert.deepEqual(imported.map(a => a.file), ["中文-素材.png", "music.mp3", "中文-素材-2.png"]);
  assert.deepEqual(imported.map(a => a.kind), ["image", "audio", "image"]);
  assert.equal(imported[0].bytes, 5);
  assert.equal((await listAssets(root, project.id)).length, 3);
  assert.equal(await fs.readFile(first, "utf8"), "image");
});

test("素材拒绝扩展名、越界、符号链接和超限文件，选项先全验证", async t => {
  const { root, project, put } = await fixture(t);
  const good = path.join(root, "good.png"), bad = path.join(root, "bad.html"), link = path.join(root, "link.png");
  await fs.writeFile(good, "image"); await fs.writeFile(bad, "<html>"); await fs.symlink(good, link);
  await assert.rejects(importAssets(root, project.id, [good, bad]), /扩展名/);
  assert.deepEqual(await listAssets(root, project.id), []);
  await assert.rejects(importAssets(root, project.id, [link]), /符号链接/);
  await put("inside.png"); await fs.symlink(good, path.join(project.dir, "assets", "link.png"));
  for (const file of ["../good.png", "/tmp/good.png", "a\\b.png", "link.png", "x\0.png", "inside.png/../inside.png"])
    await assert.rejects(assetPath(root, project.id, file), /路径越界/);
  const huge = path.join(root, "huge.mp4"); const handle = await fs.open(huge, "w");
  try { await handle.truncate(MAX_ASSET_BYTES + 1); } finally { await handle.close(); }
  await assert.rejects(importAssets(root, project.id, [huge]), /512 MB/);
  await fs.symlink(root, path.join(project.dir, "assets", "escape"));
  await assert.rejects(assetPath(root, project.id, "escape/good.png"), /符号链接/);
});

test("assets 步列出全部缺素材镜头 ID，补齐后走调度成功且不调用模型", async t => {
  const f = await serviceFixture(t);
  const sb = parseStoryboard({ shots: [baseShot, { ...baseShot, id: "missing-image", source: "file", asset: "a.png" },
    { ...baseShot, id: "missing-screen", source: "screen" }] });
  await f.pv.store.saveStoryboard(f.root, f.project.id, sb);
  const missing = await f.step("assets");
  assert.equal(missing.event.status, "error");
  assert.match(missing.event.message!, /missing-image.*missing-screen/);
  await f.put("a.png"); await f.put("screen.mp4"); sb.shots[2].asset = "screen.mp4";
  await f.pv.store.saveStoryboard(f.root, f.project.id, sb);
  assert.equal((await f.step("assets")).event.status, "done");
  assert.equal((await f.pv.store.get(f.root, f.project.id))?.steps.assets, "done");
  await assert.rejects(validateShotAssets(f.root, f.project.id, parseStoryboard({ shots: [{ ...baseShot, source: "file", asset: "../a.png" }] })), /one/);
});

test("beats 步解码单声道低采样率 PCM、保存节拍；手调、吸附只返回，不保存分镜", async t => {
  const f = await serviceFixture(t); await f.put("music.wav");
  assert.equal(await f.pv.beats(f.root, f.project.id), null);
  assert.equal((await f.pv.setMusic(f.root, f.project.id, "music.wav")).music, "music.wav");
  const done = await f.step("beats"); assert.equal(done.event.status, "done");
  const beats = (await f.pv.beats(f.root, f.project.id))!;
  assert.ok(Math.abs(beats.bpm - 120) < 1); assert.equal(beats.file, "music.wav");
  assert.ok(f.calls[0].includes("f32le")); assert.ok(f.calls[0].includes("8000"));
  assert.equal(f.calls[0][f.calls[0].indexOf("-ac") + 1], "1");
  assert.deepEqual((await fs.readdir(path.join(f.project.dir, "out"))).filter(name => name.endsWith(".pcm")), []);
  const adjusted = await f.pv.setBeatGrid(f.root, f.project.id, { bpm: 100, offset: 0.5, beatsPerBar: 3 });
  assert.equal(adjusted.bpm, 100); assert.equal(adjusted.bars[1], 2.3); assert.equal(f.calls.length, 1);
  await f.pv.store.saveStoryboard(f.root, f.project.id, { shots: [baseShot] });
  const original = await f.pv.store.read(f.root, f.project.id, "storyboard.json");
  assert.equal((await f.pv.snapStoryboard(f.root, f.project.id, "bar")).shots[0].seconds, 1.8);
  assert.equal(await f.pv.store.read(f.root, f.project.id, "storyboard.json"), original);
  await f.pv.removeAsset(f.root, f.project.id, "music.wav");
  assert.equal((await f.pv.store.get(f.root, f.project.id))?.music, undefined);
  assert.equal(await f.pv.beats(f.root, f.project.id), null);
});

test("无配乐及 ffmpeg 未就绪给明确错误；解码失败清理临时 PCM", async t => {
  const f = await serviceFixture(t);
  assert.match((await f.step("beats")).event.message!, /先.*配乐/);
  await f.put("music.wav");
  await f.pv.setMusic(f.root, f.project.id, "music.wav");
  const missing = new FfmpegService({ userData: f.root, platform: "darwin", envPath: "", systemFs: {
    stat: async () => { throw new Error("missing"); }, access: async () => {},
  }, request: async () => { throw new Error("No network"); }, run: async () => 0, approve: async () => false, plan: async () => { throw new Error("No plan"); } });
  await assert.rejects(decodeMusic(f.root, f.project.id, "music.wav", missing, f.deps.run, new AbortController().signal), /ffmpeg 未就绪/);
  await assert.rejects(decodeMusic(f.root, f.project.id, "music.wav", f.deps.ffmpeg, async (_bin, args) => {
    await fs.writeFile(args.at(-1)!, "bad"); return 1;
  }, new AbortController().signal), /解码失败/);
  assert.deepEqual((await fs.readdir(path.join(f.project.dir, "out"))).filter(name => name.endsWith(".pcm")), []);
  await f.put("still.png"); await assert.rejects(f.pv.setMusic(f.root, f.project.id, "still.png"), /必须是音频/);
  await f.pv.setMusic(f.root, f.project.id, null);
  assert.equal((await f.pv.store.get(f.root, f.project.id))?.music, undefined);
});

test("没有分析也可解码取得真实时长再手调，切换配乐清除旧网格", async t => {
  const f = await serviceFixture(t); await f.put("music.wav"); await f.put("next.wav");
  await assert.rejects(f.pv.setBeatGrid(f.root, f.project.id, { bpm: 120, offset: 0, beatsPerBar: 4 }), /请先设置配乐/);
  await f.pv.setMusic(f.root, f.project.id, "music.wav");
  const beats = await f.pv.setBeatGrid(f.root, f.project.id, { bpm: 120, offset: 0.5, beatsPerBar: 4 });
  assert.equal(beats.duration, 16); assert.equal(beats.beats[0], 0.5); assert.equal(f.calls.length, 1);
  assert.equal(beats.file, "music.wav"); assert.equal(beats.confidence, 0);
  await f.pv.setMusic(f.root, f.project.id, "next.wav");
  assert.equal(await f.pv.beats(f.root, f.project.id), null);
  await assert.rejects(fs.stat(path.join(f.project.dir, "beats.json")), {code:"ENOENT"});
  await assert.rejects(f.pv.setBeatGrid(f.root, f.project.id, { bpm: 0, offset: 0, beatsPerBar: 4 }), /参数/);
  assert.equal(f.calls.length, 1);
});

test("只读协议读取 assets 图片/音频，保留 Range/HEAD、根目录隔离和扩展名限制", async t => {
  const { root, project, put } = await fixture(t);
  await put("音乐.wav", "0123456789"); await put("image.png", "image");
  await put("bad.svg", "<svg/>");
  const url = await assetUrl(root, project.id, "音乐.wav");
  assert.ok(url.includes("/assets/"));
  const get = (file: string, init?: RequestInit) => servePvMedia(new Request(file, init), () => root);
  let response = await get(url, { headers: { Range: "bytes=2-5" } });
  assert.equal(response.status, 206); assert.equal(response.headers.get("Content-Type"), "audio/wav");
  assert.equal(await response.text(), "2345");
  response = await get(await assetUrl(root, project.id, "image.png"), { method: "HEAD" });
  assert.equal(response.headers.get("Content-Type"), "image/png"); assert.equal(await response.text(), "");
  for (const file of ["assets/%2e%2e%2fsecret.mp4", "assets/bad.svg", "project.json", "remotion/src/index.tsx", "assets/a%5cb.png", "assets/%00.wav"])
    assert.equal((await get(`sikeoop-pv://${project.id}/${file}`)).status, 403);
  await fs.symlink(path.join(project.dir, "assets", "image.png"), path.join(project.dir, "assets", "link.png"));
  assert.equal((await get(`sikeoop-pv://${project.id}/assets/link.png`)).status, 403);
  assert.equal((await servePvMedia(new Request(url), () => null)).status, 404);
});

test("compose 复制引用的图/视频/音乐到 public，模板带 Img/OffthreadVideo/Audio", async t => {
  const f = await serviceFixture(t);
  await f.put("image.png", "image bytes"); await f.put("video.mp4", "video bytes"); await f.put("music.wav", "music bytes");
  await f.pv.setMusic(f.root, f.project.id, "music.wav");
  await f.pv.store.saveStoryboard(f.root, f.project.id, { shots: [{ ...baseShot, source: "file", asset: "image.png" },
    { ...baseShot, id: "two", source: "screen", asset: "video.mp4" }] });
  assert.equal((await f.step("compose")).event.status, "done");
  for (const [file, contents] of [["image.png", "image bytes"], ["video.mp4", "video bytes"], ["music.wav", "music bytes"]])
    assert.equal(await fs.readFile(path.join(f.project.dir, "remotion", "public", "assets", file), "utf8"), contents);
  const source = await f.pv.store.read(f.root, f.project.id, "remotion/src/index.tsx");
  assert.match(source, /<Img /); assert.match(source, /<OffthreadVideo .*muted/); assert.match(source, /<Audio /);
  const media = JSON.parse(await f.pv.store.read(f.root, f.project.id, "remotion/src/media.json"));
  assert.equal(media.music, "music.wav"); assert.equal(media.assets["video.mp4"].kind, "video");
  const noMusic = remotionTemplate(f.project, { shots: [baseShot] });
  assert.equal(JSON.parse(noMusic["src/media.json"]).music, null);
});

test("render 有音乐显式 AAC 混音、补齐短音乐；无音乐保留第一批转码参数", async t => {
  for (const music of [true, false]) {
    const f = await serviceFixture(t);
    await f.put("music.wav"); if (music) await f.pv.setMusic(f.root, f.project.id, "music.wav");
    await f.pv.store.saveStoryboard(f.root, f.project.id, { shots: [baseShot] });
    await f.pv.store.write(f.root, f.project.id, "remotion/package.json", "{}");
    await f.pv.store.write(f.root, f.project.id, "remotion/src/media.json", JSON.stringify({music:music?"music.wav":null,assets:{}}));
    await f.pv.store.write(f.root, f.project.id, "remotion/node_modules/@remotion/cli/remotion-cli.js", "// fixture");
    const previous = f.events.length;
    const output = await f.pv.renderPreview(f.root, f.project.id);
    assert.ok(output.endsWith(".mp4")); assert.equal(f.calls.length, 3);
    const transcode = f.calls[1]; assert.ok(transcode.includes("mpeg4"));
    if (music) {
      assert.ok(transcode.includes("1:a:0")); assert.ok(transcode.includes("aac"));
      assert.ok(transcode.includes("apad")); assert.ok(transcode.includes("-shortest"));
    } else {
      assert.equal(transcode.filter(arg => arg === "-i").length, 1);
      assert.ok(!transcode.includes("-c:a")); assert.ok(!transcode.includes("-map"));
    }
    // renderPreview resolves at dispatch completion; allow its owned status write to settle.
    for (let i = 0; i < 200 && !f.events.slice(previous).some(e => e.step === "render" && e.status === "done"); i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(f.events.slice(previous).some(e => e.step === "render" && e.status === "done"));
    assert.ok(await fs.stat(output.replace(/\.mp4$/, ".srt")));
  }
});

test("新增 IPC 从主进程 picker 导入，不接受 renderer 任意源路径；工作区切换后拒绝", async t => {
  const f = await serviceFixture(t); const selected = path.join(f.root, "selected.png");
  await fs.writeFile(selected, "picked");
  const methods = new Map<string, (...args: any[]) => unknown>();
  let picked = 0;
  registerPvIpc((name, fn) => methods.set(name, fn), f.pv, f.deps.ffmpeg, async () => { picked++; return [selected]; });
  for (const name of ["assets", "importAssets", "removeAsset", "assetUrl", "setMusic", "beats", "setBeatGrid", "snapStoryboard"])
    assert.ok(methods.has("pv:" + name));
  const call = (name: string, ...args: unknown[]) => Promise.resolve(methods.get("pv:" + name)!(null, ...args));
  const imported = await call("importAssets", f.root, f.project.id, ["/not-selected/secret.png"]) as { file: string }[];
  assert.equal(imported[0].file, "selected.png"); assert.equal(picked, 1);
  assert.equal((await call("assets", f.root, f.project.id) as unknown[]).length, 1);
  assert.ok(String(await call("assetUrl", f.root, f.project.id, "selected.png")).includes("/assets/"));
  await assert.rejects(call("importAssets", os.tmpdir(), f.project.id), /当前项目/); assert.equal(picked, 1);
  const switched = new Map<string, (...args: any[]) => unknown>();
  registerPvIpc((name, fn) => switched.set(name, fn), f.pv, f.deps.ffmpeg, async () => { f.deps.root = () => os.tmpdir(); return [selected]; });
  await assert.rejects(switched.get("pv:importAssets")!(null, f.root, f.project.id), /当前项目/);
});

test("重启遗留 running 读回并落盘 todo，get/list 恢复但不重置本进程真实活动步骤", async t => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const f = await serviceFixture(t, { model: async () => { started(); await gate; return "恢复后的立项"; } });
  const p = structuredClone(f.project);
  p.steps.brief = "running"; p.steps.beats = "running"; p.steps.render = "running"; p.steps.script = "done"; p.updatedAt = 0;
  await f.pv.store.write(f.root, p.id, "project.json", JSON.stringify(p));
  const originalWrite = f.pv.store.write.bind(f.pv.store);
  let writes = 0;
  t.mock.method(f.pv.store, "write", async (...args: Parameters<PvStore["write"]>) => { writes++; await originalWrite(...args); });
  const copies = await Promise.all(Array.from({ length: 8 }, () => f.pv.store.get(f.root, p.id)));
  assert.equal(writes, 1);
  for (const recovered of copies) {
    assert.equal(recovered?.steps.brief, "todo"); assert.equal(recovered?.steps.beats, "todo");
    assert.equal(recovered?.steps.render, "todo"); assert.equal(recovered?.steps.script, "done");
    assert.ok(recovered!.updatedAt > 0);
  }
  const saved = JSON.parse(await f.pv.store.read(f.root, p.id, "project.json"));
  assert.equal(saved.steps.beats, "todo");
  saved.steps.assets = "running"; await f.pv.store.write(f.root, p.id, "project.json", JSON.stringify(saved));
  assert.equal((await f.pv.store.list(f.root))[0].steps.assets, "todo");
  await f.pv.runStep(f.root, p.id, "brief");
  try {
    await entered;
    const live = (await f.pv.store.get(f.root, p.id))!;
    assert.equal(live.steps.brief, "running");
    // An unrelated orphaned step must still recover while this project's brief job is alive.
    live.steps.beats = "running"; await f.pv.store.write(f.root, p.id, "project.json", JSON.stringify(live));
    const checked = (await f.pv.store.get(f.root, p.id))!;
    assert.equal(checked.steps.brief, "running"); assert.equal(checked.steps.beats, "todo");
  } finally { release(); }
  for (let i = 0; i < 200 && !f.events.some(e => e.step === "brief" && e.status === "done"); i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(f.events.some(e => e.step === "brief" && e.status === "done"));
});
