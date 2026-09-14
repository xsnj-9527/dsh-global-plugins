---
name: midtask-interrupt
description: Use when the user sends a message while you are mid-task (steering input), or when configuring/verifying how DSH delivers messages sent during a running turn — 中途插话、忙碌时回车、steer、queue、立刻停手保留进度快速响应、busyEnter 设置。
---

# Interrupt Handler · 用户中途插话：立刻停手、保留进度、快速响应

## 机制（DSH 真实实现，非推测）

DSH 的 agent 有一个 inbox，用户消息按**投递通道**分两类：

| 通道 | API | 语义 |
|---|---|---|
| `next-turn` | `agent.followup(msg)` | 排队，**等当前回合跑完**才作为新回合被受理 |
| `next-step` | `agent.steer(msg)` | 在**下一个步骤边界**注入，当前回合继续跑但模型立刻能看到 |

Web 端按「忙碌时按回车」的偏好决定用哪条：默认 `queue`，可改成 `steer`。

- 设置位置：宿主用户设置文档 `~/.dsh/settings.yaml` → `ui-conversation.busyEnter: steer`（热加载，改完即生效，无需重启）。
- GUI 里也有对应开关（设置 → 对话 → 忙碌时回车行为：排队 / 插话）。
- **Ctrl / Cmd + Enter 取反**：偏好是 `steer` 时按 Ctrl+Enter 就变排队，反之亦然（`ComposerSubmissionPolicy.resolve`）。

**投递窗口是 best-effort**：如果在没有开启步骤窗口的时刻 steer（例如整回合正在收尾），
AgentLoop 会把它降级为排队项（源码注释原话：*"turns a closed-window submission into the next waking Queue item"*）。

### 边界：什么做不到

- **正在跑的原子命令无法中断**。steer 只在我两次工具调用之间的边界可见。
  所以一条阻塞 3 分钟的命令 = 你的插话最多也要等 3 分钟。
  → **纪律：单个阻塞命令 ≤ ~30 秒，长任务用后台 job + 短轮询**，边界才会很快到来。
- DSH 目前**没有"只中断当前步骤、保留本回合"的能力**（`cancel()` 默认连 inbox 一起清空；
  `cancel(cause, { keepInbox: true })` 能保留待办，但中断的是整个回合）。这是上游的已知限制。

## 收到插话时的剧本

```
1. 停手      —— 不再启动新任务/新长命令/新子代理；已在跑的后台 job 记下 id
2. 保留进度  —— 1~3 行写清「已完成 / 未完成 / 下一步」，半成品落盘或指明位置
3. 快速响应  —— 先结论，后必要上下文；不写长篇报告，不重复已说过的内容
4. 等指示    —— 用户说继续就从保留点接着做；说改方向就按新的来
```

### 反例（不要这样）

| 反例 | 为什么不行 |
|---|---|
| 先把当前任务做完再回话 | 这正是用户要修掉的行为；插话的意义就是打断 |
| 回一句"好的，我马上处理"然后继续跑 | 等于没停，用户还是被晾着 |
| 停下但不说进度 | 用户不知道到哪一步了，无法判断该继续还是改向 |
| 把整段计划重贴一遍 | 用户要的是"现在什么状态"，不是重新听一遍方案 |
| 为"被打断"反复道歉 | 浪费用户时间，一次都不必 |

## 进度保留怎么写

有文件产出的任务，把状态写进磁盘（例如 `~/.dsh/state/<task>.json`），回复里只给指针：

```
已完成：解析了 20 个文件，结果在 /tmp/scan.json
未完成：剩下 3 个目录（第 4 批）
下一步：node scan.js --from=4  即可续跑
```

后台任务写 id：`job id bash-3 仍在跑（每 20 秒采样一次），要收结果说一声，我 job_output 给你。`

## 怎么验证 steer 真的生效

会话日志是 `$DSH_SESSION_JSONL`（zstd，多帧）。每个投递都会留下 `agent/inbox/spliced` 事件：

```json
{"target":"next-step","start":0,"inserted":[{"content":[{"type":"text","text":"…"}],
 "source":{"kind":"user"},"role":"user","id":"…"}]}
```

统计脚本（判断模式）：
- **用户消息大量落在 `next-turn`** → 还在排队，插话没生效；
- **用户消息落在 `next-step`** → steer 生效，我在下一个步骤边界就能看到。

本机历史对照（同一会话内，设置改之前）：
用户消息 **18 条 `next-turn`**，仅 **2 条**尝试 `next-step`（且因窗口关闭被降级回 queue）——
这就是"发消息要等我跑完"的直接证据。

## 相关文件

- 策略：`~/.dsh/AGENTS.md` 第 5 节
- 设置：`~/.dsh/settings.yaml` → `ui-conversation.busyEnter`
- 实现（DSH 源码）：`packages/api/session-controller/src/commands.ts`（`mode === 'steer'` 分支）、
  `packages/client/ui-conversation/src/client/input/submission-policy.ts`（按键 → 通道）、
  `packages/core/agent/src/inbox.ts`（投递投影）
