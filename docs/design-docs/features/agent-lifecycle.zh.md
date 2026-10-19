# Agent 生命周期：启动 → 对话 → 完成（中文版）

一个 agent 从头到尾：怎么被起来、一条消息怎么真的送到它手里、它干的活怎么变成
你能看见的东西、一轮怎么结束。这份文档是读代码写的，每句话都能指到一个函数。

英文版：[`agent-lifecycle.md`](agent-lifecycle.md)。逐条参考（命令、RPC、CLI 约定）
在 [`tmm-cli.md`](tmm-cli.md)；这份讲的是**顺序**，以及那些"只存在于几个模块之间"
的不变量。

![生命周期流程](agent-lifecycle-flow.zh.svg)

贯穿全文的一个区分：**应用做的事**（spawn、往 pane 里打字、往房间里写）和
**应用观测到的事**（hook 触发，我们去读）。UI 上显示的每一个状态都来自后者；
前者从来没有资格断言 agent 处于什么状态。

## 1 · 启动

`hub_spawn` → `projects::spawn::spawn()`（`projects/spawn.rs`）。

| 步骤 | 做什么 | 为什么在这儿 |
|---|---|---|
| `registry_get(agent)` | 读出定义 | 一个 agent 是注册表里的一行，不是一条命令 |
| 每项目上限 | 任何 agent 都能 spawn（`can_hire` 门禁于 2026-09-26 取消——招募是 `tmm` 本来就有的能力，不是注册表里的权限）；项目上限约束扇出 | worker 到处分身是 bug，由上限兜底 |
| 上限 `SPAWN_CAP = 8` | 数这个 session 里的 agent 窗口 | 每个窗口都在真烧 token |
| 窗口名 | `dev`、`dev-2`… | **窗口名就是 agent 的身份** —— 遥测、`tmm`、消息投递、托管门禁全都以它为键 |
| `agent_home()` | `<ws>/.tmm/agents/<名字>/` | 隔离 home。`KIRO_HOME` / `CODEX_HOME` / `--settings` 都指向这里，用户自己的配置漏不进来；这个目录同时也是"**这个 agent 是我们创建的**"的定义（`projects::managed_home`） |
| `render_kiro/claude/codex` | 配置 + hooks + MCP + skills | hooks 在这里写下；以后每次启动 `refresh_hooks` 都会重写它 |
| `LaunchRecipe::write` | 隔离 home 里的 `launch.json`：backend、环境、身份命令（原样存，kick 从不进配方）、spawned_by、team、agent_def、member；结构体字段即文件的键（board #153） | **重启必须重放完整身份。**没有配方时，重启跑的是裸后端命令（`kiro-cli chat --resume-id …`——没有 `KIRO_HOME`、没有 `--agent`），即用户空间配置，而它的 hooks 永远不触发：agent 还能回答，但观测上全聋——没有工具行、没有自动转发、条条消息 "unconfirmed"（2026-08-18 使用者报告）。`relaunch_line` = 配方环境 + 身份命令 + resume 参数；`refresh_hooks` 为旧 agent 回填配方 |
| `new_named_window` → `wait_for_shell` → `. launch.sh` | 真正把 CLI 起来 | 启动命令是 source 一个脚本，绝不用 `send-keys` —— tty shim 会吞掉 ≳2 KB 的突发输入。只在新 pane 的 shell 画出提示符后才打字（`tmux::wait_for_shell`，最多等 5 s）——更早打进去的行会被 zsh 初始化时清掉（board #325） |
| `bus.post` | `[tmm] spawned dev — brief` | 房间就是记录 |

给这个 pane 的环境变量 —— `TMM_PROJECT`（session）和 `TMM_AGENT`（窗口名）——
就是 `tmm` 全部的身份机制。没有注册调用，没有握手。

重启单个 agent 时，会先按它的定义刷新材料，再照启动配方重放。重启整个 TEAM
（`hub_team_restart`，board #286）时，先把 team 和当前定义对齐：已从定义里移除的
成员停掉、保留 home，新加的成员启动，其余成员重启
（[agents-overview.md § Agent teams](agents-overview.md#agent-teams-board-74)）。

## 2 · 一轮开始

agent CLI 起来之后停在交互提示符上，**不被搭话就什么都不做**。system prompt 里
的 brief 是背景，真正的发令枪是作为 CLI 位置参数传进去的 `KICK`。

这第一句话同时也是我们观测到的第一件事：`userPromptSubmit` 触发 → helper 往
inbox 写一个信封 → `consume_file`（`agent_notifications.rs`）转成
`telemetry::record_prompt`，**回合从这一刻开开**。chip 从此显示 `running 0s`。

## 3 · 人发一条消息

`hub_post`（`server/hub_rpc.rs`）做两件可以分开的事——把它们混在一起，我们已经
付过一次代价了：

1. **记录。** `bus.post` 写入房间 `proj:<session>` —— SQLite，也是整篇文档里
   唯一持久的东西。
2. **投递。** `deliver_mentions` 把 `[tmm chat] <谁>: <正文>` 打进每个被 @ 到的
   agent 的 pane，因为交互式 CLI 只对**自己的输入**有反应，不会去读数据库。
   只发给托管窗口：`@all` 绝不能打进用户手工起的 kiro。

如果收件人属于 Agent Team，当前消息前面会先放一段只作背景的上下文：从它上次
收到投递之后，房间里其他人的消息按 `发送者 -> 收件人: 正文` 列出。这样一个很久
没被唤醒的成员能知道队友之间发生了什么。当前任务放在最后（board #279），模型
最后读到的就是它要回答的内容；非 Team agent、hook 自动回复和 Board 通知都不带
这段上下文。
hook final 会把真实回复目标写进房间消息的 `to` 字段，但不改变可见正文。

三种收件人，三种投递——一个名字打进一个 agent 的 pane，`@all` 打进所有 managed agent
的 pane，没有收件人则谁的 pane 都不打（房间替他们留着，等他们下次 `tmm log`）。打进去
的消息不会取消正在进行的一轮：空闲时开始新的一轮，忙时按 CLI 和输入模式，等这一轮
结束或并入这一轮；只有 `tmm agent interrupt` 会取消一轮。

打进去的那行带**本地日期和时间**：`[tmm chat 2026-08-17 16:31] human: …`。这是给
读的那一方用的：CLI 读到这行时，这段对话可能已经空了几个小时，而"这句话是什么时候
说的"是它无法自己恢复的上下文——它自己的时钟只能告诉它"现在"。spawn 的 KICK 同理
也带了时间戳；而 system prompt **不带**，因为那段 prompt 每次窗口恢复都会重放，
写死一个日期几天后就是在说谎。`tmm log` 也改成渲染成同样的本地时间，而不是打印原始
的 epoch 毫秒——那个数字对 agent 来说什么都推不出来。

然后是让"投递"这件事变诚实的那一半：`send-keys` 成功只证明 pane 存在。证明 CLI
**把它当成了 prompt** 的唯一证据，是这个 agent 自己的 `userPromptSubmit` 把那行
回传回来 —— `record_delivery` 把它记成待确认，`record_prompt` 匹配上就清掉
（用包含匹配，因为正在打字的 agent 提交时会带上自己的残留文本），UI 上那条消息
标成**已送达**。`DELIVERY_ACK_SECS = 45` 秒还没回来？`sweep_deliveries` 报一条
警告，而且在任何详细级别下都显示——因为它讲的是用户刚发出去的那条消息。

## 4 · 一轮之内的工作

`preToolUse` / `postToolUse` → `tool_event_parts()` → `record_tool(名字, 参数)`。
名字和参数一路分开传到客户端，这样名字才能成为那一列带颜色、可以竖着扫下去的
东西，也省得客户端去猜哪个空格是分隔符（路径和 shell 命令里都有空格）。

客户端（`hub.ts::feedBlocks`）把同一个窗口连续的工具事件折成一组；一条消息、
一次状态声明或一个生命周期事件都会断开这个 run —— 这正是"一组 = 两次回复之间"
的含义。agent 自己的 `tmm send/log/spawn` 会被过滤掉
（`isSelfReport`）：它们的**效果本身**已经是一行了。

顺序不是免费的，需要三件事同时对：inbox 按文件名顺序消费（事件是**消费时**打
时间戳的，所以消费顺序就是渲染顺序）、时间戳是真毫秒、真出现平局时把观测排在
消息之前（回复是"结束这一轮"的那个动作）。

## 5 · 一轮结束

`stop` 带 `assistant_response`，也是唯一带答案的 hook。`userPromptSubmit`
会从 `[tmm chat …] sender:` 信封中记录本轮的回复目标；同一轮进行中再到的
输入会把它的发送者追加进去，而不是覆盖（#256）；`[reply]` 和旧
`[done]` 信封不建立反向边。

`maybe_auto_post` 只处理托管 agent，把 final response 记录进房间，并由
`TeamRoomPoster` 以 `[tmm chat <ts>] <agent>: [reply] <answer>` 投递给本轮
发送者。`[reply]` 不再产生反向回复边，因此结果只走一跳，不会 ping-pong。
最终回复上限仍是 6144 字符。

不再有显式 done 状态。stop hook 同时结束回合、记录最终消息并把它返回请求者。
主动 `tmm send` 是新的提问或交接，不会抑制 final response。

**被外部取消的 turn 没有自己的边界**：打断（`hub_agent_interrupt` /
composer 的空输入两拍 / `tmm agent interrupt`）会**先**重置派生状态
（`record_interrupt`：end = 立即 completed，清掉 ask → 马上读作
`idle`），然后才把命名的 `Escape` 键打进 pane。不先重置的话，最新事实一直是
打开那个被取消 turn 的 `userPromptSubmit`，卡片会一直显示 `running`
（owner，2026-08-29）。

## 状态：三个状态，一条规则

![状态机](agent-status-states.zh.svg)

规则就是"**哪条回合边界是最新的事实**"，而 `since` 是客户端计时的起点——
`running` 时它是这一轮的**开始**，所以"running 2m14s"说的是这一轮跑了多久。
agent 不声明状态；`send --status` 只是一条不打扰其他人的房间进度消息。
失败的一轮也只是**结束**（board #354）：没有第四个"不妙"状态，派生出来的
`idle` 用 detail `last_turn_failed` 把这件事说清楚，stop 本身仍然在活动日志
和 feed 里。

## 什么能活下来

| | 进程内重启 | 服务端重启 | 整机重启 |
|---|---|---|---|
| 聊天消息（`bus`，SQLite `team.db`） | ✅ | ✅ | ✅ |
| 项目 + agent 槽 + resume id（`state.db`） | ✅ | ✅ | ✅ |
| 隔离 home、hooks、prompt（`<ws>/.tmm/agents/`） | ✅ | ✅ | ✅ |
| 每窗口会话 id 记忆 | ✅ | ❌（下一个 hook 重新学到） | ❌ |
| 遥测：工具行、输入行、警告 | ✅ | ❌ | ❌ |
| 回复目标（activity 恢复）、待确认投递 | ✅ | ✅ | ❌（turn 已消失） |
| agent 进程本身 | ✅（tmux 比我们活得久） | ✅ | ❌ |
| agent 的窗口和对话（重启后带回） | 不适用 | 不适用 | ⚠️ `restore_on_start` 打开时，或执行 `tmm project restore --run`（#422） |

最后三行的不对称就是这套设计最诚实的总结：**对话是持久的，观测不是。**

整机重启后（#422）：上次 checkpoint 时在线、已稳定的窗口会回来，agent 用保存的对话 id 重新启动；进程、窗口内的分屏布局、普通 shell 里正在跑的命令，以及最后一次 tick 之后才建的 session 不会回来（见 projects.md § Known edges）。

还有一样东西表格里放不下，但同样不会"存活"：**运行中 CLI 的配置**。CLI 只在
启动时读一次配置，所以 `refresh_hooks` 修补磁盘只能救*下一次*启动，救不了当前
进程——一个在某 hook 存在之前就启动的 agent，会一直缺这个 hook，直到重启为止
（2026-08-18 的 "unconfirmed" 报告正是这样开始的：lead 早于 `userPromptSubmit`
hook 的提交三小时启动，此后一直没重启过）。

## 梳理中发现的问题

按"能误导用户的程度"排序。

1. **prompt 的改动到不了已经存在的 agent。** `refresh_hooks` 每次启动都修 hooks，
   并且刻意不碰别的——但 system prompt 里带着那一次给的 brief，重建不出来。所以
   上周 spawn 的 agent 现在还揣着上周的指令（包括已经被删掉的"要宣布自己在工作"
   那句）。要修，得先把 brief 存到 slot 上。
   *（相关但已于 2026-08-18 修复：重启现在通过持久化的配方重放完整启动身份——
   hooks 最新的配置、隔离 home、resume id。上面说的 brief 过期是仍然遗留的部分。）*
2. **遥测随 server 一起死**（见上表）。重启之后消息在、产生它的工作没了，读起来
   像"agent 凭空答了一句"。落到 `state.db` 就能解决；那时 120 条上限就从内存约束
   变成保留策略。
3. **警告会出现在离它讲的那条消息很远的地方。** `sweep_deliveries` 是客户端拉取时
   才跑的，而且用 `now_ms()` 打时间戳，不是用那条待确认消息自己的时刻——所以十分钟
   前没送达的消息，会产生一条排在"现在"的警告。应该带上待确认那行的时间戳。
4. **每个窗口只能有一条待确认投递。** `Rec.pending` 是单个槽位：连着给同一个 agent
   发两条 @ 消息，第一条的回执被静默丢掉，于是它既不显示已送达也不报警。需要一个
   小队列。
5. **遥测用窗口索引做键，而身份是窗口名。** tmux 开了 `renumber-windows on` 时，
   杀掉一个窗口会让索引平移，记录可能挂到另一个 agent 上。应该按名字做键，或者读
   的时候校验名字。
6. **spawn 的上限把不属于我们的窗口也数进去。** `SPAWN_CAP` 数的是"看起来像 agent"
   的窗口，所以用户在项目 session 里手工起的 kiro 会占掉 4 个名额之一。
7. **hook 到消费之间改名会丢掉这次回帖。** `maybe_auto_post` 是在消费时解析窗口名
   的；如果窗口在那 250 毫秒里被改名，托管门禁不通过，回复被丢掉且没有任何提示。
8. **投递没有背压。** 不管 agent 是不是正在一轮里，消息都会被打进 pane。它能工作
   是因为这些 CLI 会把输入排队，而不是因为这里有任何保证。
9. **两条完全相同的正文会让回执认错人。** `feedBlocks` 用包含匹配把回声配到消息上，
   所以同样的话发两遍，只有后一条会被标成已送达。
10. **`TeamRoomPoster` 忽略 `record_only`。** 今天是安全的（那个实现从不投递），但
    这个不变量写在注释里而不是类型里——第二个实现者得重新发现它。
