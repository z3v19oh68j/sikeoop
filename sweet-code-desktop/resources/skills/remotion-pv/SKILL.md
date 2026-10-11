---
name: remotion-pv
description: 在用户 PV 项目中按分镜编写确定性的 Remotion 组件。
---

# Remotion 合成
工作范围仅 remotion/。先读 src/storyboard.json，再修改 src/index.tsx。依赖写入本项目 package.json，不安装到应用，不自动运行联网安装。
使用 useCurrentFrame 和 useVideoConfig，动画只由帧数驱动，不使用 Date.now、随机数或定时器。逐镜 seconds×fps 四舍五入为整数，Sequence 累计排布，总帧数按相同规则计算。保留 Composition id=PV。
## 画面
每镜以 visual 为设计依据，caption 为字幕；不要把整段分镜描述直接当成最终画面。分离背景、主体、字幕三层，比例由项目决定，四周留安全区。缺素材使用清楚标注的代码图形，不能伪称真实录屏。
## 检查
检查首尾帧、字幕裁切、Sequence 衔接。默认输出 out/preview.mp4，禁止改应用目录。使用者自行核对 Remotion 团队许可。
