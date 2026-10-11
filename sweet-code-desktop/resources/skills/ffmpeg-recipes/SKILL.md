---
name: ffmpeg-recipes
description: 本地 PV 转码、字幕、抽帧和响度处理的命令参考。
---

# ffmpeg 本地配方
使用已经审批下载并校验的绝对路径。不经 shell 拼接命令，参数用数组传给进程。输入、输出限定在当前 PV 项目，输出使用新文件名，失败保留诊断但不发布半成品。
## 命令参数
抽封面：-nostdin -i INPUT -frames:v 1 OUTPUT.jpg
等比缩放：-nostdin -i INPUT -vf scale=1280:-2 -c:v libopenh264 OUTPUT.mp4
转码：-nostdin -i INPUT -c:v libopenh264 -pix_fmt yuv420p -movflags +faststart OUTPUT.mp4
音频响度：-nostdin -i INPUT -af loudnorm=I=-16:TP=-1.5:LRA=11 OUTPUT.wav
裁剪：-nostdin -ss 2 -i INPUT -t 5 -c:v libopenh264 OUTPUT.mp4
## 注意
先读取 -encoders 确认构建具备编码器，不要为了 libx264 悄悄换 GPL 构建。外部字幕优先独立 SRT；烧录字幕要正确转义滤镜路径，不能把用户输入直接插进滤镜表达式。音乐版权、素材许可由项目记录，不自动下载网络音乐。
