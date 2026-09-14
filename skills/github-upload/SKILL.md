---
name: github-upload
description: Use when uploading, pushing, or committing files to a GitHub repository for this user — 往 GitHub 传文件、提交代码、push、新建仓库并上传、gh_push.js、或者遇到 WSL 里 GitHub 连不上/超时/失败重试。
---

# GitHub Publisher · 往 GitHub 传文件（gh_push.js）

## 一条命令，别无其他

```bash
node /home/zch2026/gh_push.js -m "提交说明"                      # 提交并推送当前仓库
node /home/zch2026/gh_push.js --repo=/path/to/repo -m "提交说明"  # 指定仓库
node /home/zch2026/gh_push.js --status                          # 只体检，不推送（秒回）
node /home/zch2026/gh_push.js --create=<名字> --private -m "…"    # 新建仓库并推送
node /home/zch2026/gh_push.js --dry-run                         # 演练：只扫描与预览提交
```

用 bash 工具调用时 `timeoutMs` 给 `180000`。正常情况 3~10 秒返回。

**前置条件只有一条：用户的梯子（Sororain）开着。** 别的一律由脚本自理。

## 为什么必须这样（2026-09-12 实测结论）

WSL **不读取 Windows 的系统代理**，所以 WSL 里的 git/gh/curl 默认走裸链路；而裸链路上
GitHub 是**间歇性整段不可用**的（不是"某个 IP 坏"）：

| 观测 | 数据 |
|---|---|
| WSL 直连 `api.github.com` | 连续 **10/10 全超时** |
| 同一时刻 Windows 走代理 | **全绿**，0.4~1.5 秒 |
| 抖动窗口内换 IP | 4 个边缘 IP **同时**全挂 → 说明是链路，不是单点 |
| TUN（虚拟网卡）模式 | 只对 `github.com` 有效，`api.github.com`/百度/SSH 全卡死 → **别用** |

结论：**让 WSL 走 Windows 的代理**才是正路。已经配置好：

- `~/.hermes/scripts/wsl-proxy.sh` —— 代理端口可达才注入 `http_proxy/https_proxy`，不可达静默跳过
  （所以梯子关掉也不会把 WSL 网络弄挂）。已接入 `~/.bashrc` 与 `~/.hermes/scripts/dsh-autostart.sh`
  （**以后新开的每个会话自动生效**）。
- `~/.local/bin/gh` 垫片（真身 `.gh-real`）—— gh 自动走代理；只读命令遇网络错误重试 3 次，写操作不重试。
- `gh_push.js` 内部也自带同样的代理自举，所以它不依赖上面两个文件。

## 脚本内置的六道保险

1. **代理自举**：可达才注入，不可达静默回退直连。
2. **密钥扫描**：提交前扫 `gho_/ghp_/github_pat_/AKIA/私钥/PASSWORD=/api_key=`，命中即中止（退出码 2）。
3. **双通道推送**：原 `origin` 失败且属网络错误 → 自动换另一协议（SSH ↔ HTTPS）再试。
4. **有界重试**：只重试网络类错误，最多 3 次、间隔 3 秒；**永不使用 `--force`**。
5. **结果核验**：`git ls-remote` 比对远端 SHA 与本地 HEAD，用 `remoteVerified` 说话。
6. **结构化输出**：`[SUCCESS]`/`[NOTHING_TO_PUSH]`/`[SECRET_FOUND]`/`[FAILED]` + JSON。

## 四种场景的剧本

**A. 更新已有仓库里的文件（最常见）**
```bash
node /home/zch2026/gh_push.js --repo=<目录> -m "改了什么"
```
脚本自己 `git add -A` → 提交 → 推送 → 核对 SHA。

**B. 新建仓库并上传**
```bash
node /home/zch2026/gh_push.js --repo=<目录> --create=<仓库名> --private -m "首次提交"
```
`--private` / `--public` **必须显式二选一**：公开是不可逆的对外发布，用户没明确说 public 就一律选 private
（建完可以一条命令改成公开，反过来不行）。

**C. 只想知道现在什么状态**
```bash
node /home/zch2026/gh_push.js --status --repo=<目录>
```
返回代理状态、远端 SHA、待提交文件数、是否有改动。**不改任何东西。**

**D. 危险动作前的预演**
```bash
node /home/zch2026/gh_push.js --repo=<目录> --dry-run
```
只做密钥扫描和"将要提交哪些文件"的预览。

## 失败模式与对策

| 输出 | 含义 | 处理 |
|---|---|---|
| `[SECRET_FOUND]` | 扫到令牌/私钥/明文密码，已中止 | 移除或改用环境变量；确属误报再人工处理 |
| `[NOTHING_TO_PUSH]` | 工作区干净，没有可提交内容 | 正常，无需处理 |
| `查不到 origin 远端` | 目录里没有 remote | 用 `--create` 新建，或先 `git remote add origin <url>` |
| `推送失败（两种通道都试过）` | 网络或鉴权问题 | 确认梯子开着、`gh auth status` 正常，然后**重跑同一条命令**（幂等、安全） |
| `remoteVerified:false` | 推送命令成功但没取到远端 SHA | 再跑一次 `--status` 核对，不要凭 push 输出宣称成功 |
| 提交但推不上去 | 非快进（远端有新提交） | `git pull --rebase` 后重跑；**不要 force** |

## 哪些事必须问用户

- 新建仓库的**可见性**（private/public）——公开不可逆；
- 把**已有私有仓库改成公开**；
- 提交里包含**大文件**（>50MB）或二进制产物；
- 用户没说清楚**传到哪个仓库**时（能自己查到的除外：`git remote -v`、`--status`）。

## 仓库现状（本机）

| 仓库 | 地址 | 用途 |
|---|---|---|
| `dsh-global-plugins` | https://github.com/xsnj-9527/dsh-global-plugins | 三个全局插件：DST 上传器、需求分析、GitHub 上传 |

本地工作副本在 `/home/zch2026/dsh-global-plugins`，`origin` 用 SSH。
`gh` 已登录 `xsnj-9527`（令牌在 `~/.config/gh/hosts.yml`，scope 只有 `repo`；
个别涉及组织信息的子命令可能提示缺 `read:org`，仓库读写不受影响）。
