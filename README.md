# DSH 全局插件（用户级）

本仓库收录给 **DeepSeek Harness (DSH)** 用的五个"全局插件"：它们不是 Cordis 插件行，而是
**用户级策略文件 + 技能 + 独立脚本**的组合——这样它们对本机**所有**会话生效（含子代理），
不受 preset 限制，也不会被 DSH 升级覆盖。

| # | Name | 具体功能 | 组成 |
|---|---|---|---|
| 1 | **Workshop Publisher** | 一条命令把《饥荒联机版》模组发布/更新到 Steam 创意工坊。上传前先向 Steam 查询远程是否已是同一份内容，是则直接返回成功（幂等）；内容有变才打包上传。原生 Windows 图标编译、单次请求 15s / 引擎 150s / 同步等待 60s 三层硬超时，结束时固定输出状态码与 JSON（含 `canRetry`、`nextAction`） | `smart_upload.js` + `skills/dst-workshop-upload/` |
| 2 | **Requirement Gate** | 接到任务先做需求分析再动手：复述目标与验收标准，检查四类漏洞（表意不明 / 逻辑漏洞 / 缺关键参数 / 高风险不可逆）；能自己读代码查到的事实不许问，确有真问题就用一次 `ask_user_question`（≤3 条、带候选）敲定后再开工，没问题则直接干 | `AGENTS.md` 第 1 节 + `skills/requirement-analysis/` |
| 3 | **GitHub Publisher** | 一条命令提交并推送文件到 GitHub 仓库。自动探测并注入 WSL→Windows 代理、提交前密钥扫描（命中即中止）、SSH 与 HTTPS 双通道互为备份、只重试网络类错误（最多 3 次、永不 `--force`），最后用 `git ls-remote` 核对远端 SHA 而不是轻信 push 自述 | `gh_push.js` + `skills/github-upload/` |
| 4 | **Windows Bridge** | 把 WSL 调 Windows 程序收成一个入口，修掉两个真实坑：Windows 控制台按 GBK 吐字节被当 UTF-8 解码导致中文全是乱码；经 PowerShell 5.1 转发会吞引号、合并参数。按「BOM → 严格 UTF-8 → GBK936」判定解码，`winps` 自动钉 UTF-8 输出编码 | `win.sh` + `AGENTS.md` 第 4 节 |
| 5 | **Interrupt Handler** | 用户在我干活时发来的消息改为在**下一个步骤边界注入**（steer），而不是排队等我跑完这一回合；收到后立刻停手、用 1~3 行保留进度（已完成/未完成/下一步），先给结论再给上下文 | `AGENTS.md` 第 5 节 + `skills/midtask-interrupt/` |

> `AGENTS.md` 按节承载这五个插件的策略：第 1 节需求分析、第 2 节创意工坊上传、第 3 节 GitHub 上传、
> 第 4 节 Windows 命令、第 5 节中途插话。

## 安装

DSH 的用户级配置根目录是 `$DSH_HOME`（默认 `~/.dsh`）。四个动作：

```bash
# 1) 用户级策略：被每个会话开场自动注入
cp AGENTS.md "$DSH_HOME/AGENTS.md"        # 若已有，改成手动合并第 1、2、3 节

# 2) 技能：出现在所有会话的技能目录里
mkdir -p "$DSH_HOME/skills"
cp -r skills/* "$DSH_HOME/skills/"

# 3) 上传脚本
cp smart_upload.js ~/smart_upload.js

# 4) GitHub 推送脚本
cp gh_push.js ~/gh_push.js
```

装完**不需要重启**：策略文件在下一轮对话即生效，技能会被目录监听器自动收进目录。

> 插件 3 另需一次性的环境准备（WSL → Windows 代理），见下文"插件三"。

## 插件一：DST 创意工坊上传

一条命令搞定"检查 + 打包 + 上传 + 回写状态"：

```bash
node ~/smart_upload.js                 # 自动挑出待上传的模组；全都最新则直接 [SUCCESS]
node ~/smart_upload.js --mod=<id>      # 指定模组
node ~/smart_upload.js --status        # 只查询，绝不上传，秒回
node ~/smart_upload.js --list          # 列出所有模组状态
node ~/smart_upload.js --help
```

### 设计要点

- **幂等**：上传前先问"远程是不是已经是这份内容"。三条认领路径（状态文件哈希 + 远程时间戳吻合 /
  断联后遗留结果认领 / 状态丢失时按远程标题 + 体积认领），任一成立直接报成功，绝不重复上传。
  中途断联后重跑同一条命令，或跑 `--status`，都会收敛到真实状态。
- **有界**：Steam Web API 单次 15 秒；Windows 上传引擎默认 150 秒硬超时；
  本命令同步等待默认 60 秒（`--budget=`）。任何一步超时都立刻返回，绝不无限等待。
- **可解析**：结束固定打印状态码 + JSON：
  `[SUCCESS]` / `[NEEDS_UPLOAD]` / `[PENDING]` / `[FAILED_TIMEOUT]` / `[FAILED]`，
  字段含 `status` / `message` / `fileExists` / `canRetry` / `nextAction` 等。
  `canRetry` 表示"现在能不能安全重跑"，`nextAction` 直接给出下一步该执行的确切命令。
- **无 PowerShell 层**：实测从 WSL 直接拉起的 Windows 进程本身就位于交互式 Session 1
  （与 Steam 同会话），所以 `schtasks` / 计划任务 / `LogonMode Interactive` 那一整套历史机制已彻底移除。
  运行链条只剩：`WSL node → Windows node → steamworks.js → Steam`。
- **图标自动编译**：`art/modicon.png` 存在时自动调用 Mod Tools 的
  `image_build.py`（Python 2.7）编译成 `.tex/.xml`，产出逐字节可复现，PNG 一变自动重编。

### 依赖

- Windows 侧 Node 与 `steamworks.js`（放在每个模组的上传工作目录里），Steam 客户端已登录；
- 图标编译需要 Steam 免费工具 **Don't Starve Mod Tools**。

### 关键路径（**本机专用，换机器必须改**）

`smart_upload.js` 顶部与 `skills/dst-workshop-upload/SKILL.md` 里写死了本机路径：

| 常量 | 本机值 |
|---|---|
| 模组登记表 `MODS` | `/home/zch2026/woodie_mod` → `D:\woodie_upload` 等 |
| Windows Node | `/mnt/c/Program Files/nodejs/node.exe` |
| Mod Tools | `/mnt/d/Software/Steam/steamapps/common/Don't Starve Mod Tools/mod_tools` |

## 插件二：开工前需求分析

`AGENTS.md` 第 1 节要求：接到任务先分析需求再动手——复述目标、找四类漏洞
（表意不明 / 逻辑漏洞 / 缺关键参数 / 高风险不可逆）、**能自己查清的不许问**、
确有问题就用一次提问（最多 3 条，带候选选项）敲定后再开工、没有问题就直接干、
纯只读与单步琐碎任务跳过形式化分析。

配套技能 `skills/requirement-analysis/` 提供完整检查清单、提问模板与反例。

## 插件三：往 GitHub 传文件

```bash
node ~/gh_push.js -m "提交说明"                      # 提交并推送当前仓库
node ~/gh_push.js --repo=<目录> -m "提交说明"         # 指定仓库目录
node ~/gh_push.js --status                          # 只体检，不推送
node ~/gh_push.js --create=<名字> --private -m "…"    # 新建仓库并推送
node ~/gh_push.js --dry-run                         # 演练：只扫描与预览
```

### 要解决的问题

WSL **不读取 Windows 的系统代理**，所以 WSL 里的 git/gh/curl 默认走裸链路，而裸链路上
GitHub 是**间歇性整段不可用**的。实测（2026-09-12）：

| 观测 | 数据 |
|---|---|
| WSL 直连 `api.github.com` | 连续 **10/10 全超时** |
| 同一时刻 Windows 走代理 | **全绿**，0.4~1.5 秒 |
| 抖动窗口内换边缘 IP | 4 个 IP **同时**全挂 → 是链路问题，不是单点 |
| TUN（虚拟网卡）模式 | 只对 `github.com` 有效，`api.github.com`/百度/SSH 全卡死 → **不要用** |

### 一次性环境准备

1. 代理客户端里开启 **`allow-lan`**（配置文件 `shared_preferences.json` 与 `config.yaml`，
   UI 里可能没有这个开关），让代理从只监听 `127.0.0.1` 变为对 WSL 可见。
2. 放一个 `~/.hermes/scripts/wsl-proxy.sh`：**代理端口可达时才**导出 `http_proxy/https_proxy`，
   不可达静默跳过（梯子关掉不会把 WSL 网络弄挂）。把它 source 进 `~/.bashrc`，
   并在 `~/.hermes/scripts/dsh-autostart.sh` 里 source 一次 → **以后每个新会话自动继承**。
3. 可选：给 `gh` 加一个垫片（真身改名 `.gh-real`），自动走代理 + 只读命令网络错误重试。

`gh_push.js` 内部自带同样的代理自举，所以即使不做第 2、3 步它也能工作；那两步是为了让
**其它**命令（curl / pip / npm / apt / 交互式 gh）也一起受益。

### 六道保险

代理自举 → 密钥扫描（命中即中止）→ 双通道推送（SSH ↔ HTTPS 互为备份）→
只重试网络错误（最多 3 次，**永不 `--force`**）→ `git ls-remote` 核对远端 SHA →
结构化输出 `[SUCCESS]/[NOTHING_TO_PUSH]/[SECRET_FOUND]/[FAILED]` + JSON。

## 插件四：WSL 调 Windows 的入口（win / winps）

Windows 程序经 WSL interop 调用时按 OEM 代码页 936 吐字节，而 DSH 一律按 UTF-8 解码，
于是中文全变 `����`；经 cmd / PowerShell 5.1 转发还会吞引号、合并参数（实测 6 个参数变 5 个）。

`win.sh` 把这条路收成一个入口：直接 interop 启动、按「BOM → 严格 UTF-8 校验 → GBK936」判定解码、
`winps` 前置 UTF-8 输出编码（这是本机唯一能救回 `✓`、emoji 这类 GBK 表示不了的字符的办法）。

```bash
win <程序> [参数...]        # 例如 win whoami / win node -v
winps '<PowerShell 代码>'   # 默认 PowerShell 7，自动钉 UTF-8
```

完整取舍、实测记录见 `AGENTS.md` 第 4 节与 `win.sh` 头部注释。

## 插件五：用户中途插话（立刻停手、保留进度、快速响应）

### 要解决的问题

用户在我干活时发消息，默认行为是 `queue`：**要等我这一回合跑完才被受理**，人只能干等。
本仓库交付的是两半：把投递通道换成 `steer`（机制），加上"收到就停手"的响应纪律（行为）。

### 机制（DSH 真实实现）

DSH 的 agent inbox 有两个投递目标：

| 通道 | API | 语义 |
|---|---|---|
| `next-turn` | `agent.followup(msg)` | 排队，等当前回合跑完才作为新回合受理 |
| `next-step` | `agent.steer(msg)` | 在**下一个步骤边界**注入，当前回合继续跑但模型立刻能看到 |

Web 端按「忙碌时按回车」偏好决定用哪条，默认 `queue`。改法（热加载，无需重启）：

```yaml
# ~/.dsh/settings.yaml
ui-conversation:
  busyEnter: steer
```

GUI 设置里也有对应开关；**Ctrl / Cmd + Enter 取反**（偏好 steer 时按它就是排队）。

**边界（要说清楚）**：steer 只在我两次工具调用之间可见——正在跑的原子命令无法中断。
所以一条阻塞 3 分钟的命令 = 插话最多也要等 3 分钟。
→ 纪律：单个阻塞命令 **≤ ~30 秒**，长任务用后台 job + 短轮询，边界才够快。
DSH 目前也**没有**"只中断当前步骤、保留本回合"的能力（`cancel()` 默认连 inbox 一起清空）。

### 响应纪律（`AGENTS.md` 第 5 节）

```
1. 停手     不再启动新任务/新命令；后台 job 记下 id
2. 保留进度 1~3 行写清「已完成 / 未完成 / 下一步」，半成品落盘或指明位置
3. 快速响应 先结论后上下文，不写长篇报告，不重复已说过的内容
4. 等指示   说继续就从保留点接着做，说改方向就按新的来
```

### 本机实测证据

同一会话的日志统计（设置改动之前）：用户消息 **18 条走 `next-turn`（排队）**，
仅 **2 条**尝试 `next-step` 且因窗口关闭被降级回 queue —— 这正是"发消息要等我跑完"的直接证据。
读法：会话日志里每个 `agent/inbox/spliced` 事件的 `target` 字段即投递通道。

## 说明

- 本仓库文件**不含任何密钥、令牌或密码**（已扫描确认）；
  内含的是本机绝对路径与公开的创意工坊条目 ID。
- 这些插件按"策略 + 技能 + 脚本"而不是 Cordis 插件行实现是刻意的：插件行只对挂了它的 preset 生效，
  而这些需求要**默认对所有会话生效**；且升级 DSH 不会覆盖用户级配置。

## License

[MIT](LICENSE)
