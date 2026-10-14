---
name: remotion-pv
description: 在用户 PV 项目中按分镜编写确定性的 Remotion 组件。
---

# Remotion 合成
工作范围只在 remotion/ 内。先读 src/storyboard.json，再改 src/index.tsx。依赖只写进本项目的 package.json，不安装到应用，不自动联网安装。保留 Composition id="PV"，fps 固定为 30（与应用模板一致）。

## 画面只由帧号决定
- 时间只用 useCurrentFrame() 和 useVideoConfig() 取得，t = frame / fps。
- 禁止 Date.now、Math.random、setTimeout、setInterval、requestAnimationFrame。CSS 或 SVG 自带的 animation 也不用，改由帧号算出 style。
- 需要“随机”的抖动，用由帧号推出的确定数（例如 Math.sin(frame * 12.9898) 的小数部分），同一帧永远得到同一结果。
- 时长：每镜帧数 = Math.round(seconds * fps)；Sequence 的 from 按镜头顺序累加；总帧数是各镜取整后的和。

## 常用动效（用帧号算进度）
```ts
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const seg = (f: number, a: number, b: number) => clamp((f - a) / (b - a), 0, 1); // 把 [a,b] 映成 0–1
const easeOut = (k: number) => 1 - (1 - k) ** 3;
const easeOutBack = (k: number) => 1 + 2.70158 * (k - 1) ** 3 + 1.70158 * (k - 1) ** 2; // 弹出
```
- 淡入：opacity = seg(f, 0, 12)，约 0.4 秒。
- 位移：y = (1 - easeOut(seg(f, 0, 12))) * 40。
- 弹出：scale = easeOutBack(seg(f, 0, 18))。
- 打字机：n = Math.floor(seg(f, a, b) * text.length)，显示 text.slice(0, n)。
- 依次出现：第 i 个元素的起点 = 基准帧 + i * 间隔；间隔取一拍，120 BPM 时为 15 帧。
- 也可以用 Remotion 的 interpolate(f, [a, b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })，结果与上面等价。

## 素材、配乐、字体
- 素材放在 remotion/public/assets/，用 staticFile("assets/<文件名>") 引用。图片用 <Img>，视频用 <OffthreadVideo muted>，视频原声静音，声音只由配乐层负责。
- 配乐用 <Audio src={staticFile("assets/<配乐>")} />，放在最外层，不放进镜头 Sequence，避免被镜头截断。
- 缺素材时用代码图形（渐变底、几何形、CSS 文字）占位，并在代码注释里标注“待素材”。占位不能伪装成真实录屏。
- 字体文件放进工程，用 @font-face 加载；加载前用 delayRender 挂起，加载完再 continueRender。不依赖本机装了什么字体。

## 三层结构与安全区
- 背景层（底色或素材）、主体层（本镜的主要动作）、字幕层（最上层，独立的 AbsoluteFill）。
- 安全区：横屏四周留约 8%；竖屏底部留约 20%，避开平台按钮。
- 字幕每行约 16 个汉字以内，最多两行，用高对比底板；超出就拆镜，不缩成看不清的小字。

## 写法示意
```tsx
const Caption: React.FC<{ text: string }> = ({ text }) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: "20%" }}>
      <div style={{ opacity: seg(f, 0, 6), color: "#fff", background: "rgba(0,0,0,.6)", padding: "8px 20px" }}>
        {text}
      </div>
    </AbsoluteFill>
  );
};
```

## 检查
1. 读 storyboard.json，核对镜头数与 Sequence 数一致，各镜帧数之和等于 durationInFrames。
2. 用 remotion still 抽首帧、末帧和每镜中间帧，例如 npx remotion still src/index.tsx PV out/check.png --frame=N。
3. 逐帧看字幕是否被裁切、是否在安全区内，相邻 Sequence 交界处有没有闪黑。
4. 默认输出 out/preview.mp4，不改应用目录。预览通过后再交给 ffmpeg-recipes 转成最终格式。
5. 汇报里写清抽了哪些帧、看了什么；没有逐帧看过的照实写。
6. Remotion 的许可条款由使用者自行核对（团队或商用规模）。
