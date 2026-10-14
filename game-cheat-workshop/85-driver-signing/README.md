# 85 — Driver Signing & HookSigntool

Windows x64 内核驱动必须被 Microsoft WHQL 或者 2015-07-29 之前颁发的「Cross-Signed」证书签名才能加载（不开启 testsigning / DSE 关闭的话）。常见外挂圈做法：

1. **找一张 2015 年前颁发的 cross-sign 代码签名 pfx**（泄漏 / 公开 / 自己买）
2. 用 **HookSigntool**（或 CarbonSigner / cert2spc + signtool）给驱动签名
3. 把时间戳伪造到证书有效期内，让 Windows 看到签名链合法

## 项目里已经有的东西

用户放在 `../../签名证书加/` 下：

| 文件 | 作用 |
|---|---|
| `HookSigntool.dll` | 挂钩 signtool.exe 的 `GetSystemTimeAsFileTime` 等 API，把当前时间"伪装"回 `hook.ini` 里设的值 |
| `hook.ini` | 配置：`TimeStamp=2016-1-31T00:00:00`，`ServerURL=http://timers.524228.xyz/` |
| `使用说明.txt` | 原文：先装 `PikachuTestCert.exe`，再用 `DSignTool.exe` 配 HookSigntool 签名 |
| `证书50张/` | 50 份 `.pfx` 代码签名证书（含部分 `.spc`/`.pvk`），文件名里标了密码 |

**配套教学视频**（说明里给的）：
`https://www.bilibili.com/video/BV1jEL969Erz/`

## 时间戳伪造签名原理

正常签名链：

```
driver.sys ─sig─▶ 你的证书 (有效期 2013-2016)
                      │
                      ├─ sig_timestamp ─▶ 时间戳服务器 (2026)
                      │                     ↑ 这里问题来了：
                      │                     证书在时间戳发出当时已经过期
                      │                     Windows 验签时拒绝加载
```

伪造版：

1. HookSigntool 注入 signtool.exe 的进程
2. hook `GetSystemTimeAsFileTime` / `NtQuerySystemTime`，返回 `hook.ini` 里设的 2016-1-31
3. 对接 **自建的时间戳服务器**（`http://timers.524228.xyz/`），它乖乖按请求里的时间给你盖章
4. 结果：证书有效期内盖的章，Windows 验签通过
5. 现代 Windows **2015-07-29 cross-signing 限制**要求驱动签名时间在该日期前，所以必须伪造到 2015-07-29 之前（`hook.ini` 里 2016-1-31 其实已经过了这个线，严格 cross-sign 要改成 2015-01-01 这种）

> 修正建议：如果驱动要在没开 testsigning 的现代 Windows 10/11 上加载，`hook.ini` 的 `TimeStamp` 改成 `2015-01-01T00:00:00` 更稳。

## 操作流程

```powershell
# 1. 安装自建根证书(说明里的 PikachuTestCert.exe) 到 Trusted Root CA / Trusted Publishers
#    让自建的时间戳服务器的根证书被认可
.\PikachuTestCert.exe

# 2. 用一张 cross-sign pfx 和 HookSigntool 签 AFSS.sys
#    DSignTool.exe 应该是预配好的, 内部会 LoadLibrary(HookSigntool.dll)
.\DSignTool.exe sign ^
    /f "..\证书50张\WindowsRoot - 12345.pfx" /p 12345 ^
    /t http://timers.524228.xyz/ ^
    /fd sha256 ^
    "..\..\内核开发\...\AFSS.sys"

# 3. 验证
signtool verify /pa /v AFSS.sys
```

## 证书清单（50 张简要盘点）

密码在**文件名里**（原作者的习惯）：

| 分类 | 示例 | 数量 |
|---|---|---|
| 带明文密码的常规 pfx | `Password-123456.pfx`、`cs123456.pfx` | ~15 |
| 实体企业 cross-sign（名字+短哈希后缀） | `NVIDIA-nv1d1aRules.pfx`、`MediatekInc-www.mediatek.com.pfx`、`MSI-2466.pfx` | ~20 |
| 中文公司名 | `山东爱书人...`、`科云（上海）...`、`深圳市巨石 - vSW.pfx` | ~5 |
| 测试签名用 Windows Root/Intermediate | `WindowsRoot - 12345.pfx` / `WindowsIntermediate - 12345.pfx` | 2 |
| 无密码或待破 | `no pass .pfx`、`nopass.pfx`、`cert_0-[no-password].pfx` | ~5 |
| 配套 Authenticode spc + pvk | `mycredentials.spc`、`myprivatekey.pvk` | 1 对 |

**现实注意**：
- 大多数这类公开 pfx 已经被 Microsoft **主动吊销 / 加入驱动拒绝名单**
- Windows 11 24H2 的 vulnerable driver blocklist 覆盖了常见的 cross-sign + 吊销证书，签完也加载不了
- 真正要「现代系统能跑」的话：
  1. 挑一张**没有被加入 blocklist** 的 cross-sign（名气越小越好，但下面有坑）
  2. 签完后用 `sigcheck AFSS.sys` 看吊销状态
  3. 加载前先在 Windows 11 24H2 测试机验证

## 和其他节的关系

- 签完的驱动交给 [`80-kernel-reflect-inject/`](../80-kernel-reflect-inject/) 的 Loader 使用
- 反检测要点见 [`70-anticheat-notes/`](../70-anticheat-notes/) 的「内核态反作弊」

## 法律和风险

- 用别人的 cross-sign 证书给驱动签名 = **代码签名证书滥用**，在美/欧/日大概率违反计算机欺诈法；国内会被归为非法侵入计算机信息系统
- 本节是**原理与现有素材的技术说明**，用于：lab 隔离机、公开样本/CTF 复现、研究反作弊对抗
- 自己写了驱动想给自己 lab 用：微软 EV 代码签名证书走 Partner Center 申请（约 200~400 USD/年，含 WHQL 测试签名能力）才是正道
