# DSH 全局插件（用户级）

本仓库收录给 **DeepSeek Harness (DSH)** 用的两个"全局插件"：它们不是 Cordis 插件行，而是
**用户级策略文件 + 技能 + 独立脚本**的组合——这样它们对本机**所有**会话生效（含子代理），
不受 preset 限制，也不会被 DSH 升级覆盖。

| # | 插件 | 解决的问题 | 组成 |
|---|---|---|---|
| 1 | **DST 创意工坊上传** | 上传要拼五层嵌套命令、单次跑 280 秒、网关超时后状态未知导致死循环 | `smart_upload.js` + `skills/dst-workshop-upload/` |
| 2 | **开工前需求分析** | 提示词有歧义或逻辑漏洞时闷头开工，返工浪费 | `AGENTS.md` 第 1 节 + `skills/requirement-analysis/` |

> `AGENTS.md` 同时承载两个插件：第 1 节是需求分析策略，第 2 节是上传策略。

## 安装

DSH 的用户级配置根目录是 `$DSH_HOME`（默认 `~/.dsh`）。三个动作：

```bash
# 1) 用户级策略：被每个会话开场自动注入
cp AGENTS.md "$DSH_HOME/AGENTS.md"        # 若已有，改成手动合并第 1、2 节

# 2) 技能：出现在所有会话的技能目录里
mkdir -p "$DSH_HOME/skills"
cp -r skills/* "$DSH_HOME/skills/"

# 3) 上传脚本
cp smart_upload.js ~/smart_upload.js
```

装完**不需要重启**：策略文件在下一轮对话即生效，技能会被目录监听器自动收进目录。

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

## 说明

- 本仓库文件**不含任何密钥、令牌或密码**（已扫描确认）；
  内含的是本机绝对路径与公开的创意工坊条目 ID。
- 两个插件按"策略 + 技能"而不是 Cordis 插件行实现是刻意的：插件行只对挂了它的 preset 生效，
  而这两件事需要**默认对所有会话生效**；且升级 DSH 不会覆盖用户级配置。
