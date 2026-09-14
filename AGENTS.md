# 用户级执行策略（对本机所有会话生效）

## 1. 开工前的需求分析（默认对每个任务生效）

接到任何任务时，**先分析需求，再动手**：

1. **复述目标**：用一两行说清"要交付什么"，以及怎么算做完（验收标准）。
2. **找漏洞**：重点查这四类问题——
   - **表意不明**：指代不清（"那个东西"）、范围不清（改哪个文件/哪个模组）、程度不清（"优化一下"到底优化什么）；
   - **逻辑漏洞**：要求自相矛盾、缺前置条件、步骤顺序根本不可能成立；
   - **缺关键参数**：路径、目标对象、取舍标准（快 vs 稳、删 vs 留、本地 vs 上线）；
   - **高风险且不可逆**：删除、覆盖、对外发布、发消息给他人、花钱——必须显式确认，不能自行决定。
3. **能自己查清的不许问**：读代码、读文件、搜索能确定的事实先自己查清楚。拿这类问题占用用户时间是不合格的。
4. **确有问题 → 先提问，敲定后再开工**：用 `ask_user_question` **一次问清**（最多 3 条，每条给候选选项），不要多轮盘问，也不要边猜边做。问完把用户的选择复述一句，再开始。
5. **没有问题 → 不要为了问而问**：用 2~4 行写出"目标 / 关键假设 / 计划"，然后直接干活。分析是为了少返工，不是为了走流程。
6. **可以跳过形式化分析的场合**：纯只读查询、单步琐碎操作（看个文件、列个目录、跑个状态查询、回答一个知识问题）——直接做。

更具体的既有规则优先于本节：plan 模式、动态 Cordis 插件流程、以及下面第 2、3、4 节的"只允许一条命令/一条流程"。

详细检查清单与提问模板见技能 `requirement-analysis`。

## 2. DST 创意工坊上传：只允许一条命令

任何"把《饥荒联机版》模组上传到 Steam 创意工坊"的任务，**唯一允许**的执行方式是：

```
node /home/zch2026/smart_upload.js
```

工作目录是 `/home/zch2026` 时可以简写成 `node smart_upload.js`。
指定模组：`node /home/zch2026/smart_upload.js --mod=woodie|twinflower`。

**禁止事项**（2026-09-12 事故原因：Bash → Python → PowerShell → schtasks → 交互式会话 五层嵌套，
单次执行 280 秒后网关超时，状态未知导致反复重试直至死锁）：

- 不要再拼接多层嵌套命令；不要再用 PowerShell / schtasks / 计划任务去"进交互式会话"——已证实不需要。
- 不要手工运行 `D:\*_upload\upload.js`、`run_in_session1.ps1`、`upload_woodie.ps1`、`ModUploader.exe`。
- 不要为"查一下到底传成功没有"另写命令，用 `node /home/zch2026/smart_upload.js --status`（秒回，绝不上传）。
- 不要在同一回合里对同一份内容反复重跑上传；先看 `canRetry`。

### 怎么读结果（脚本永远这样收尾）

最后一行一定是状态码，紧跟着一段结构化 JSON：

```
[SUCCESS] / [NEEDS_UPLOAD] / [PENDING] / [FAILED_TIMEOUT] / [FAILED]
{ "status": ..., "message": ..., "fileExists": ..., "canRetry": ..., "nextAction": ... }
```

- `status`：`"success"` | `"failed"`
- `fileExists`：创意工坊条目是否存在（远程真实查询结果）
- `canRetry`：**现在**能不能安全地重跑这条命令。`false` 就不要重跑。
- `nextAction`：下一步该执行的**确切命令**，照做即可，不要自己发明流程。

### 超时预算

- 脚本自身有界：Steam API 单次 15s、Windows 上传引擎默认 150s 硬超时、命令同步等待默认 60s。
- 用 bash 工具调用它时 `timeoutMs` 给 120000 就够，绝不给它无限等待的机会。
- 超时不等于失败：`[PENDING]` + `canRetry:false` 表示上传仍在后台进行，
  等 30 秒后执行 `--status` 收结果即可；重复执行同一条命令也是安全的（幂等）。

详细架构、加新模组、故障排查见技能 `dst-workshop-upload`。

## 3. 往 GitHub 传文件：只允许这一条流程

用户说"传到我的 GitHub / 上传到仓库 / 帮我 push / 提交代码"时，**唯一允许**的执行方式是：

```
node /home/zch2026/gh_push.js -m "提交说明"                      # 提交并推送当前仓库
node /home/zch2026/gh_push.js --repo=<目录> -m "提交说明"         # 指定仓库目录
node /home/zch2026/gh_push.js --status                          # 只体检（代理/鉴权/远端/待提交），不推送
node /home/zch2026/gh_push.js --create=<名字> --private -m "…"   # 新建仓库并推送
```

前置条件只有一条：**用户的梯子（Sororain）开着**。
脚本自己会注入 WSL→Windows 代理（与 `~/.hermes/scripts/wsl-proxy.sh` 同一套判断），代理不可达时静默跳过。

**禁止事项**：

- 不要在 WSL 里裸连 GitHub——裸链路会间歇性整段超时（实测 `api.github.com` 曾连续 10 次全挂，
  而同一时刻 Windows 走代理全绿）。临时需要代理的命令先 `. ~/.hermes/scripts/wsl-proxy.sh`。
- 不要用 `git push --force`（脚本永不使用）。
- 不要跳过密钥扫描（脚本内置，命中即中止并报出文件与类型）。
- **不要擅自新建公开仓库、也不要把私有仓库改成公开**——公开是不可逆的对外发布，
  必须用户明确说 public；`--create` 必须显式二选一 `--private` / `--public`。
- 不要混用 Windows 侧的 git / gh：WSL 侧已经有代理自举和 `gh` 垫片（含只读重试）。

**怎么读结果**（与上传脚本同一套约定）：

```
[SUCCESS] / [NOTHING_TO_PUSH] / [SECRET_FOUND] / [FAILED]
{ "status": ..., "message": ..., "commit": ..., "remoteVerified": ..., "canRetry": ..., "nextAction": ... }
```

`remoteVerified:true` 表示已用 `git ls-remote` 核对远端 SHA 与本地一致——**不要只看 push 的自述就宣称成功**。

完整剧本、通道选择与排错见技能 `github-upload`。

## 4. 跨到 Windows 的命令：只走 `win` / `winps`

WSL 里调 Windows 程序时，**唯一允许**的执行方式是这两个命令（2026-09-13 落地并实测）：

```
win [--raw|--utf8|--gbk] [--stream[=编码]] [--timeout SEC] [--wincwd DIR] <程序> [参数...]
winps [--ps5] '<PowerShell 代码>'
```

- 裸程序名只查 Windows 目录（System32 / WindowsPowerShell / PowerShell7 / nodejs / Git / WindowsApps），
  **刻意不查 WSL 的 PATH**——要跑 WSL 里的程序（git / python / node 的 Linux 版）就别用 `win`。
- 显式路径写成 `/mnt/c/...` 或 `C:\...` 都行（含斜杠即原样使用）。
- `winps` 默认用 PowerShell 7，并自动把输出编码钉成 UTF-8；要 5.1 加 `--ps5`。
- 退出码原样返回；超时返回 124；用法错误返回 2。

**为什么**（2026-09-13 实测，非推测）：

- Windows 控制台程序经 interop 调用时按 OEM 代码页 936 吐字节，而 DSH 一律按 UTF-8 解码，
  中文全变 `����`。`win` 读回原始字节后按「BOM → 严格 UTF-8 校验 → GBK936」判定再解码。
- `win` 直接 interop 启动、不经 cmd 也不经 PowerShell，argv 原样透传。
  实测一组 6 个含空格 / 内嵌引号 / 尾反斜杠的参数：直连 interop、`win`、`winps` 三者逐字节一致，
  而经 Windows PowerShell 5.1 会变成 5 个（`he said "hi"` 的引号被吃掉，末尾两个参数被并成一个）；
  同样这组再加中文（7 个参数）时，5.1 因为脚本按 GBK 误读直接 ParserError，根本跑不起来。
- `winps` 会前置 `[Console]::OutputEncoding = UTF8`，这是本机唯一能救回 `✓`、emoji
  这类 **GBK 表示不了的字符**的办法——5.1 的 `$OutputEncoding` 默认 `us-ascii`，
  会在字符到达解码器之前就把它变成 `?`。

**禁止事项**：

- 不要再裸写 `cmd.exe /c ...`、`powershell.exe -Command ...` 抓输出——中文必乱，
  而且你分不清那是乱码还是真的报错。
- 不要手写 `[Console]::OutputEncoding=...` 前置语句，`winps` 已经加了。
- 二进制输出（`certutil`、`reg export`）不要走默认解码，用 `win --raw`。

**已知取舍**：

- 自动判定对「同一条输出里混编码」无能为力（PS 自己吐 UTF-8、它调的 cmd 又吐 GBK），
  此时用 `--utf8` / `--gbk` 显式指定。
- 默认缓冲完整输出再解码。长任务配 `--timeout`，或改 `--stream[=编码]` 看实时输出
  （该模式合并 stdout/stderr，且必须显式给编码）。
- 工作目录是 WSL 路径时 `cmd.exe` 会打一段 UNC 警告并退回 `C:\Windows`；
  需要真实 Windows 工作目录就加 `--wincwd 'C:\...'`。
- 目标程序是 GUI 且不自己退出时 `win` 会一直等到超时（例如 notepad）——这类要走别的路。

**例外**：确实不适合（GUI 交互、需要独立窗口）时可以直连 interop，
但必须在回复里说明原因，不能默认滑回去。

完整实现、自测记录与设计取舍见 `~/.hermes/scripts/win.sh`（`~/.local/bin/win` 与 `winps` 是它的软链）。

## 5. 用户中途插话：立刻停手、保留进度、快速响应

机制：本机已把「忙碌时按回车」设为 `steer`（`~/.dsh/settings.yaml` 的 `ui-conversation.busyEnter`）。
所以用户在我干活时发来的消息，会在**我下一个步骤边界**注入进来，而不是等我这一回合跑完。
这意味着：**收到插话必须立刻转向，而不是把手上的活干完再说。**

按这个顺序做：

1. **停手**：不再启动新任务、不再发起新的长命令或长耗时子代理。
2. **保留进度**：用 1~3 行写清「已完成 / 未完成 / 下一步」；半成品要落盘或指明位置，
   让续做能接着来，而不是从头再来。
3. **快速响应**：先给结论，再给必要的上下文；不写长篇报告，不重复已经说过的内容。
4. **之后**：用户要"继续"就从保留点接着做；要改方向就按新指示来。

**为了让"立刻"真的是立刻**：单个阻塞命令别超过 ~30 秒——长任务拆成后台 job + 短轮询，
这样步骤边界（也就是我能看到你消息的时刻）才会很快到来。
插话若只是补充信息（"对了，顺便…"），可以在当前这个原子步骤做完后并入；长任务一律先停。

完整机制说明、证据读法与反例见技能 `midtask-interrupt`。
