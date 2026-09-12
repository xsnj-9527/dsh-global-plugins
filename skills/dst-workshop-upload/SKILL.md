---
name: dst-workshop-upload
description: Use when uploading, updating, or checking a Don't Starve Together (《饥荒联机版》) mod on the Steam Workshop for this user — 上传/更新/查询创意工坊、伍迪真无敌、双生花、smart_upload.js、或者任何涉及 D:\\*_upload、ModUploader、steamworks.js 的上传任务。
---

# DST 创意工坊上传（smart_upload.js）

## 一条命令，别无其他

```bash
node /home/zch2026/smart_upload.js                 # 自动挑出待上传的模组；全都最新则直接 [SUCCESS]
node /home/zch2026/smart_upload.js --mod=woodie    # 指定模组（woodie | twinflower）
node /home/zch2026/smart_upload.js --status        # 只查询，绝不上传，秒回
node /home/zch2026/smart_upload.js --list          # 列出所有模组同步状态
node /home/zch2026/smart_upload.js --help
```

用 bash 工具调用时 `timeoutMs` 给 `120000`。已是最新时约 1 秒返回；真上传约 10~40 秒。

**不要再做这些事**：拼 PowerShell / `schtasks` / 计划任务 / `run_in_session1.ps1` / `upload_woodie.ps1`，
或直接跑 `D:\*_upload\upload.js`、`ModUploader.exe`。也不要为了"确认结果"另写查询命令。

## 为什么它不会再挂死

2026-09-12 的事故链是：Bash → Python → PowerShell → `schtasks` → 交互式会话(Session 1) → `node upload.js`，
五层嵌套、PowerShell 里轮询日志 180 秒，一次执行 280 秒后网关超时；因为拿不到结果，AI 只能反复重试，
最终死锁。

现在的链路只剩两层，实测总耗时 0.07 秒级的进程启动开销：

```
WSL node smart_upload.js
  └─ spawn "C:\Program Files\nodejs\node.exe" _engine.js   （cwd 经 WSL interop 映射为 D:\...）
       └─ steamworks.js ──> 已登录的 Steam 客户端 ──> 创意工坊
```

**关键实测结论：从 WSL 直接拉起的 Windows 进程本身就落在交互式 Session 1**
（`(Get-Process -Id $PID).SessionId` 返回 1，与 Steam 同会话），所以
`schtasks` + `LogonType Interactive` 那一整套"进会话 1"的机制是多余的历史包袱，已彻底移除。
PowerShell 在本脚本里一次都不出现。

## 幂等是怎么做到的（"状态未知"不再致命）

上传前先问三个问题，任何一条成立就直接 `[SUCCESS]`，绝不碰 Steam：

1. **状态文件吻合**：`D:\<mod>_upload\upload_state.json` 里的 `contentHash` 与当前内容一致，
   且 Steam Web API 返回的 `time_updated` 与记录的 `remoteTimeUpdated` 相同。
2. **孤儿结果认领**：上一轮超时/断联，但 `upload_result.json` 里留着一条
   `ok:true` 且 `contentHash` 与当前一致的结果 → 认领为成功，回写状态。
3. **远程认领**：本地状态文件丢了（第一次跑、被删），但远程条目的
   `title` 与 `file_size` 和本地完全一致 → 认领为最新，回写状态。

远程查询失败时也不会乱来：只要本地有"同内容成功过"的记录，就判为最新并标 `remoteVerified:false`，
**不会**因为查不到就重传 —— 这条规则专门用来打断"未知状态 → 反复重试"的死循环。

内容的身份是 `modicon.tex/xml + modinfo.lua + modmain.lua` 的 md5 清单哈希；
远程 `file_size` 恰好等于内容目录字节数（已用两个模组的真实数据核对：50752 / 62874）。

## 边界与超时

| 环节 | 上限 | 行为 |
|---|---|---|
| Steam Web API 单次查询 | 15 秒 | 超时 → 降级为本地判定，不阻塞 |
| Windows 上传引擎 | 默认 150 秒（`--hard-timeout=`） | 到点写 `ENGINE_TIMEOUT` 并自杀，绝不挂起 |
| 本命令同步等待 | 默认 60 秒（`--budget=`） | 到点返回 `[PENDING]`，上传继续在后台跑 |
| 需要"启动就不等" | — | `--detach`，立刻返回，之后用 `--status` 收结果 |

`--detach` / `[PENDING]` 时 `canRetry:false`：**先等 30 秒再 `--status`**，不要立刻重跑。

## 输出契约

最后一定是状态码 + 一段 JSON（`--quiet` 时只有 JSON）：

```
[SUCCESS]        已是最新或上传成功
[NEEDS_UPLOAD]   本地内容比工坊新（只有 --status 会返回它）
[PENDING]        预算用尽但上传仍在后台进行
[FAILED_TIMEOUT] 引擎硬超时
[FAILED]         其它失败（原因在 message 里，含 NO_STEAM / ENGINE_TIMEOUT / UPLOAD_FAILED 等 code）
```

JSON 固定字段：`status` / `message` / `fileExists` / `canRetry` / `code` / `mod` / `upToDate` /
`remoteVerified` / `phase` / `nextAction`（+ `itemUrl`、`logFile`、`elapsedMs`）。

**`nextAction` 就是下一步该跑的确切命令，照做，不要自己发明流程。**

## 模组登记表与新增模组

登记表在 `smart_upload.js` 顶部的 `MODS`（每个模组 6 行）：

```js
woodie: {
    title: '伍迪真无敌 Woodie The Invincible',   // 必须与工坊标题一致（远程认领靠它）
    expect: '伍迪真无敌',                        // 防呆：内容目录里的 modinfo.lua 必须包含它
    src: '/home/zch2026/woodie_mod',            // WSL 源码目录
    uploadDir: '/mnt/d/woodie_upload',          // Windows 侧上传工作目录（必须纯 ASCII 路径）
    itemId: '3800149383',                       // 已有条目 ID；新模组留空会自动创建
    tags: ['character'],
}
```

当前已登记：

| id | 标题 | 工坊条目 | WSL 源码 | Windows 工作目录 |
|---|---|---|---|---|
| `woodie` | 伍迪真无敌 Woodie The Invincible | [3800149383](https://steamcommunity.com/sharedfiles/filedetails/?id=3800149383) | `/home/zch2026/woodie_mod` | `D:\woodie_upload` |
| `twinflower` | 双生花 Twin Flowers | [3800006179](https://steamcommunity.com/sharedfiles/filedetails/?id=3800006179) | `/home/zch2026/twinflower` | `D:\dstupload` |

**新模组**：可以直接 `--src=/home/zch2026/<新目录>` 免登记上传（自动用 `D:\<目录名>_upload`），
跑顺了再把它写进 `MODS`。源码目录需要：`modinfo.lua`、`modmain.lua`、`art/modicon.png`（图标源图）、
`art/preview.png`、以及 `workshop_description.txt`（内容原样作为工坊简介；不写就沿用远程现有简介）。
额外的 lua 用 `<src>/upload_include.txt` 逐行列出（默认只传 `modinfo.lua` + `modmain.lua`，
`test_harness.lua` 这类开发文件不会被推上去）。

### 图标是自动编译的（不用你管）

`art/modicon.png` 存在时，脚本会自动调用 Mod Tools 的官方编译器把 PNG 转成 `.tex/.xml`：

```
mod_tools/buildtools/windows/Python27/python.exe compiler_scripts/image_build.py --force <png>
```

- 实测 **0.45 秒**，且**逐字节可复现**（拿两个模组的 PNG 重编，产出的 `.tex/.xml` 与线上正在用的
  md5 完全一致，所以不会因为"重编了图标"而误触发一次上传）。
- `<uploadDir>/_icon/.src.md5` 记住当前 tex 是哪个 PNG 编译出来的；**PNG 一改就自动重编**。
- 想手动强制重编：`--recompile-icon`。编译失败会给出 `[FAILED]` + 编译器最后几行输出。
- 没有 PNG 时退回沿用 `art/modicon.tex`，再没有就报错。

## 每次运行都会写的东西（排查用）

| 文件 | 位置 | 说明 |
|---|---|---|
| `_engine.js` | `D:\<mod>_upload\` | 每次重写的 Windows 侧引擎，不要手改 |
| `_job.json` | 同上 | 本轮任务参数（标题/简介/超时/哈希） |
| `_icon/` | 同上 | 图标编译暂存区 + `.src.md5`（PNG 指纹） |
| `upload_result.json` | 同上 | 引擎的机器可读结果，也是孤儿认领的依据 |
| `upload_state.json` | 同上 | 内容哈希 ↔ 远程时间戳的绑定 |
| `smart_<runId>.log` | 同上 | 引擎 stdout/stderr；失败时 JSON 的 `logFile` 指向它 |

## 故障排查

| 症状 | 处理 |
|---|---|
| `[NO_STEAM]` | Steam 客户端没开或没登录 → 让用户启动 Steam 后重跑同一条命令 |
| `[NO_MODULE]` | `D:\<mod>_upload\node_modules\steamworks.js` 丢失 → `cd /mnt/d/<mod>_upload && npm i steamworks.js` |
| 图标编译失败 | 多半是 `D:\Software\Steam\steamapps\common\Don't Starve Mod Tools` 没装（Steam 里免费），或 `art/modicon.png` 坏了；输出里会带编译器最后几行 |
| `[NON_ASCII_FILE]` / `NON_ASCII_PATH` | 内容目录有中文路径/文件名，Steam 打包器读不到（历史踩坑：中文用户名 `小米`） |
| `[NEED_AGREEMENT]` | 首次发布需在浏览器接受创意工坊法律协议：https://steamcommunity.com/sharedfiles/workshoplegalagreement |
| 一直 `[PENDING]` | 30 秒后 `--status`；若仍 `NEEDS_UPLOAD` 再重跑一次；两次都不行看 `logFile` |
| 想确认工坊真实状态 | `--list`，或直接 POST `https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/`，参数 `itemcount=1&publishedfileids[0]=<id>`（无需 API Key） |

`--status` / `--list` 是只读的：它们只做本地打包（含图标编译）、同步文件和查询，
**永远不会创建或更新工坊条目**。
