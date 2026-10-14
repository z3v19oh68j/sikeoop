---
name: ffmpeg-recipes
description: 本地 PV 转码、字幕、抽帧和响度处理的命令参考。
---

# ffmpeg 本地配方
使用应用审批下载并校验过的绝对路径。参数一律以数组传给进程，不经 shell，不拼接字符串。输入和输出都在当前 PV 项目内，输出用新文件名。失败时保留 stderr 尾部日志，删除未完成的输出，不把半成品放进 out/。

## 先确认构建
先执行 ["-hide_banner","-encoders"] 看有哪些编码器，再选配方。应用下载的是 LGPL 构建，不依赖 libx264（GPL）。libopenh264 等是否存在，用 -encoders 确认，不要假定。不确定时用原生编码器 mpeg4 和 aac，这也是应用自己出片时的组合。

## 基础出片
转码：["-nostdin","-i",IN,"-c:v","mpeg4","-q:v","3","-pix_fmt","yuv420p","-movflags","+faststart",OUT]
等比缩放：["-nostdin","-i",IN,"-vf","scale=1280:-2","-c:v","mpeg4","-q:v","3","-pix_fmt","yuv420p",OUT]
裁剪（精确到帧，-ss 放在 -i 后）：["-nostdin","-i",IN,"-ss","2","-t","5","-c:v","mpeg4","-q:v","3",OUT]
封面：["-nostdin","-ss","3","-i",IN,"-frames:v","1",OUT_JPG]

## 混音
输入顺序约定：0 视频，1 旁白，2 配乐，3 和 4 为两个音效。下面是一条 filter_complex 参数（整条作为一个数组元素传入）：
```
[1:a]aresample=48000,aformat=channel_layouts=stereo,highpass=f=90,acompressor=threshold=0.25:ratio=2.5:attack=5:release=120,volume=1.4,asplit=2[vo][vok];
[2:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.4[bgm];
[3:a]aformat=channel_layouts=stereo,adelay=4000|4000,volume=0.5[s1];
[4:a]aformat=channel_layouts=stereo,adelay=9000|9000,volume=0.5[s2];
[s1][s2]amix=inputs=2:normalize=0[sfx];
[bgm][vok]sidechaincompress=threshold=0.02:ratio=5:attack=15:release=350[duck];
[duck][vo][sfx]amix=inputs=3:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]
```
- 旁白：高通约 90Hz，轻压缩，略提音量。
- 音效：adelay 的值是毫秒，按时间点放；音量约为旁白的一半。
- 配乐：压到四成左右，用旁白的副本做侧链压缩，说话时自动让开。
- 响度：loudnorm 到 -14 LUFS、真峰值 -1.5 dB、LRA 11。
- 完整调用：["-nostdin","-i",VIDEO,"-i",VO,"-i",BGM,"-i",SFX1,"-i",SFX2,"-filter_complex",FILTER,"-map","0:v","-map","[aout]","-c:v","copy","-c:a","aac","-b:a","192k","-movflags","+faststart","-t",SECONDS,OUT]
- 配乐片尾淡出：在 bgm 链上加 afade=t=out:st=开始秒:d=4。

## 抽关键帧拼图
1. 每个时间点各抽一帧（先建好 frames/ 目录，文件名补零，便于排序）：
   ["-nostdin","-ss",T,"-i",IN,"-frames:v","1","frames/000.png"]
2. 拼成一张图：["-nostdin","-framerate","1","-i","frames/%03d.png","-vf","tile=4x2","-frames:v","1","sheet.png"]
   注意 %03d 的起始编号要和文件名对齐（先用 -start_number 确认）。

## 图片序列进视频
["-nostdin","-framerate","30","-start_number","0","-i","frames/%04d.png","-c:v","mpeg4","-q:v","3","-pix_fmt","yuv420p","-movflags","+faststart",OUT]

## 只测量，不改文件
响度复测：["-nostdin","-i",IN,"-af","loudnorm=I=-14:TP=-1.5:LRA=11:print_format=summary","-f","null","-"]

## 注意
- 字幕优先用独立 SRT，和视频分开交付。确需烧录时，先用 -filters 确认 subtitles 滤镜可用；字幕文件先复制成项目内的简单文件名，路径里的冒号、逗号、引号都会破坏滤镜表达式，不能直接拼进去。
- 音乐版权、素材许可记在项目的 CREDITS 里，不自动下载网络音乐。
- 每个配方跑完，用关键帧拼图和响度复测确认结果，再写入汇报。
