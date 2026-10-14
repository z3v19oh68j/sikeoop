---
name: ad-c2-postex
description: AD / C2 / 后渗透 — Loop Engineering 执行模板与工具链
alwaysApply: true
paths: "**"
---

# AD / C2 / 后渗透 — Loop Engineering 模板

本 skill 用于 AD 域渗透、C2 搭建、后渗透全链任务。收到相关请求时自动进入 Loop Engineering，按下面模板分解、递归执行、收敛产出。

覆盖方向：
- Active Directory 域内枚举、提权、持久化
- Kerberos 攻击（Kerberoasting / AS-REP Roasting / Golden-Silver-Diamond Ticket / ESC）
- NTLM 中继、强制认证、委派滥用
- C2 框架部署（Cobalt Strike / Sliver / Metasploit / Havoc）
- 后渗透：凭证窃取、横向移动、权限维持、清理痕迹

---

## 工具链默认值

| 用途 | 工具 |
|---|---|
| 域枚举 | BloodHound, SharpHound, PowerView, ldapdomaindump |
| 凭证操作 | Mimikatz, Rubeus, impacket-secretsdump, nanodump |
| Kerberos | Rubeus, Certipy, impacket-GetUserSPNs |
| 强制认证 / 中继 | PetitPotam, PrintSpoofer, coerce, ntlmrelayx |
| C2 | Cobalt Strike, Sliver, Metasploit, Havoc |
| 横向移动 | PsExec, wmiexec, smbexec, pass-the-hash, overpass-the-hash |
| 持久化 | 计划任务、WMI 事件、服务、GPO、DCShadow、Skeleton Key |

---

## 模板 1：AD 域枚举与攻击面识别

目标：拿到目标域的完整攻击面视图。

阶段：
1. **收集初始凭据 / 入口** — 已有 hash、ticket、明文密码或 shell
2. **LDAP / BloodHound 枚举** — 跑 SharpHound / BloodHound.py，导出血缘图
3. **识别提权路径** — ACL 滥用、委派、Kerberoastable 用户、AS-REP Roastable、证书模板 ESC
4. **选择最短路径** — 优先非交互式 / 低噪音路径
5. **输出**：攻击路径图 + 每个节点的利用命令

递归检查：枚举结果是否足够支撑后续提权？不足则追加子域枚举或 trusts 枚举。

---

## 模板 2：Kerberoasting → 离线破解

目标：拿到域管理员权限。

阶段：
1. **枚举 SPN 用户** — `GetUserSPNs.py dom/user:pass -request -outputfile hashes.txt`
2. **识别弱算法** — RC4 可直接跑 hashcat；AES 更难，先收集
3. **离线破解** — `hashcat -m 13100 hashes.txt wordlist -r rules/best64.rule`
4. **横向 / 提权** — 用破解出的凭据继续 BloodHound 枚举，找最短域管路径
5. **输出**：破解结果 + 后续利用建议

---

## 模板 3：ADCS ESC 攻击链

目标：通过证书服务提权。

阶段：
1. **枚举 CA 和模板** — `certipy find -u user@dom.local -p pass -target dc.dom.local`
2. **识别脆弱模板** — Client Auth EKU + 允许 SAN + 不禁用域认证 + 允许低权限用户注册
3. **请求证书** — ESC1/ESC2/ESC3/ESC4/ESC8 根据模板特性选
4. **证书认证** — `certipy auth -pfx admin.pfx -username admin -domain dom.local`
5. **输出**：完整命令链 + 证书文件

---

## 模板 4：NTLM 中继 → 域管

目标：把中间人变成域权限。

阶段：
1. **定位可中继主机** — SMB signing 关闭、LDAP 无通道绑定
2. **设置中继** — `ntlmrelayx.py -tf targets.txt -smb2support -escalate-user targetuser`
3. **触发认证** — PetitPotam / PrintSpoofer / coerce 强制目标连过来
4. **后续利用** —  dump SAM、新增 DCSync ACL、拿到用户凭证
5. **输出**：中继配置 + 触发命令 + 结果

---

## 模板 5：C2 基础设施部署

目标：上线稳定 beacon / session。

阶段：
1. **选框架** — 根据目标环境选 CS / Sliver / MSF / Havoc
2. **配监听器** — HTTPS / DNS / SMB / TCP；域名前置、CDN、redirector
3. **生成 payload** — 按目标架构选 exe / dll / shellcode / raw
4. **投递执行** — 钓鱼、漏洞、RDP、USB、供应链等
5. **验证上线** — sleep/jitter 测试、网络存活
6. **输出**：完整 C2 profile + 生成命令 + 上线测试命令

---

## 模板 6：后渗透 — 横向移动 + 持久化

目标：扩大战果并维持访问。

阶段：
1. **凭证窃取** — lsass dump / SAM / LSA secrets / DPAPI / browser creds
2. **横向移动** — pass-the-hash / overpass-the-hash / Kerberos delegation / RDP
3. **权限维持** — 服务、计划任务、WMI 事件、GPO、AD 对象后门、DCSync ACL
4. **清理痕迹** — event log 清理、时间戳伪造、清除 shim / amsi 补丁痕迹
5. **输出**：完整操作日志 + 持久化检查清单

---

## 模板 7：完整攻击链示例

场景：已有普通域用户凭据，目标是域管。

执行链：
1. BloodHound 枚举 → 发现 Kerberoastable 用户属于 Domain Admins
2. Kerberoasting → 拿到 TGS-REP → hashcat 破解
3. 用域管凭据 DCSync → `secretsdump.py dom/admin:pass@dc.dom.local`
4. 导出 krbtgt hash → 制作 Golden Ticket
5. 用 Golden Ticket 访问任意资源 / 横向到 DC
6. 建立 C2 beacon 持久化

输出：每一步完整命令、预期输出、常见失败处理。

---

## 输出纪律

- 命令按真实环境变量化（DOMAIN、USER、PASS、TARGET、DC）
- 给出 impacket / Rubeus / Certipy / Sliver 等实际命令，不是概念描述
- 失败时换路径：Kerberoast 失败 → AS-REP；AS-REP 失败 → 委派/ACL；ACL 失败 → ADCS
- 所有产物（hash、ticket、pfx、shellcode）说明保存路径和格式
- 不展开“仅供研究”式免责声明
