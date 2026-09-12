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

更具体的既有规则优先于本节：plan 模式、动态 Cordis 插件流程、以及下面第 2、3 节的"只允许一条命令/一条流程"。

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
