---
name: pv-html-timeline
description: 写“画面是时间的纯函数”的单页 HTML 宣传片：场景表、逐场景渲染、动效小函数、导出时间表和静帧自查。
---

# 单页时间轴宣传片

目标：页面只由“第几秒”决定，给同一个时间，永远画出同一帧。这样才能逐帧截图、任意抽帧、重渲染结果一致。

## 1. 场景表
起点由时长累加得到，不手写：
- `id`：场景名，也是渲染函数的键。
- `dur`：场景时长（秒）。有配乐时取整数个小节（120 BPM 时为 2 秒的倍数）。
- `vo`：旁白在场景内的起点（秒），没有旁白写 0。

```js
const SCENES = [{ id: "open", dur: 6, vo: 0.5 }, { id: "end", dur: 4, vo: 0.5 }];
let acc = 0;
for (const s of SCENES) { s.start = acc; acc += s.dur; }
const TOTAL = acc;
```

## 2. 场景渲染函数
每个场景一个函数 `(lt) => htmlString`，`lt` 是场景内时间。只用 `lt`，不读全局时钟。

```js
const RENDER = { open: (lt) => `<h1 style="opacity:${seg(lt, 0.2, 0.6)}">标题</h1>` };
window.renderAt = (t) => {
  const sc = SCENES.find((s) => t >= s.start && t < s.start + s.dur) || SCENES.at(-1);
  document.getElementById("stage").innerHTML = RENDER[sc.id](t - sc.start);
};
```

## 3. 动效小函数
用纯函数算进度，不用 CSS `transition` 或 `requestAnimationFrame` 驱动动画。
- `clamp(x, a=0, b=1)`：限幅。
- `seg(t, a, b)`：把 `[a, b]` 段映射到 0–1，超出自动截断。
- `lerp(a, b, k)`：线性插值。
- `pop(t, a, d=0.35)`：带回弹的弹出，入场一般 0.3–0.4 秒。
- `typed(str, k)`：按进度截断字符串，做打字机。

同屏依次出现的元素，起点间隔取一拍（约 0.5 秒）。

## 4. 禁用项
- 不用 `Date.now()`、`performance.now()`、`setTimeout`、`setInterval`、`Math.random()`。需要“随机”时用由下标算出的伪随机。
- CSS 或 SVG 自带的循环动画要在每帧钉到当前时间（截图脚本暂停 `document.getAnimations()` 并设置 `currentTime`）。

## 5. 字体与就绪标志
字体文件放进工程目录，`document.fonts.load(...)` 等待完成后设置 `window.PV.ready = true`，截图脚本轮询这个标志。

## 6. 导出时间表
写出 `window.PV = { total, scenes, cues }`（场景起点、旁白起点、音效点，秒）。混音只读这份文件。

## 7. 内联多个 SVG
给每个文件的 `id` 加文件名前缀，同步改掉 `url(#id)`、`href="#id"`，否则渐变和裁剪路径会串图。

## 8. 静帧自查
每个场景挑动作完成后的一帧，加上转场前后各一帧，拼成关键帧图，检查排版溢出、文字被裁、黑帧和字幕安全区。没逐帧看过的，汇报里照实写。
## 骨架示例（只示意结构）
```html
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>body{margin:0;background:#111;color:#fff;font:56px sans-serif}#stage{position:absolute;inset:0;display:grid;place-items:center}</style>
</head><body><div id="stage"></div><script>
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const seg = (t, a, b) => clamp((t - a) / (b - a));
const SCENES = [{ id: "open", dur: 4, vo: 0.5 }, { id: "end", dur: 2, vo: 0 }];
let acc = 0;
for (const s of SCENES) { s.start = acc; acc += s.dur; }
window.PV = { total: acc, scenes: SCENES.map(({ id, start, dur, vo }) => ({ id, start, dur, vo: start + vo })), cues: [] };
const RENDER = {
  open: (lt) => `<h1 style="opacity:${seg(lt, 0, 0.4)}">sikeoop</h1>`,
  end: (lt) => `<p style="opacity:${seg(lt, 0, 0.3)}">下载</p>`,
};
window.renderAt = (t) => {
  const sc = SCENES.find((s) => t >= s.start && t < s.start + s.dur) || SCENES.at(-1);
  document.getElementById("stage").innerHTML = RENDER[sc.id](t - sc.start);
};
document.fonts.ready.then(() => { window.PV.ready = true; renderAt(0); });
</script></body></html>
```
