# Findings: pi-weixin-hub 开发中的关键发现与坑

<!-- 磁盘上的经验库：开发中发现的重要事实、坑、行为规律。 -->

## 环境/平台
- **pi 可执行文件解析**：Windows 下 `spawn("pi")` 会 ENOENT（shim 是 .cmd/脚本，Node 不能直接执行）。rpc-client 解析到 `node_modules/@earendil-works/pi-coding-agent/dist/cli.js` 后用 `node cli.js` 启动。`PI_PATH` 指向 cli.js 时也要 node 前缀。
- **Windows 无窗口后台**：`--fork` spawn 子进程必须加 `windowsHide: true`，且 pi 子进程的 spawn 也要加（否则黑框反复出现——daemon 重连就弹）。
- **stop 命令**：Windows 上 `process.kill(SIGTERM)` 不触发 Node 信号处理（直接 TerminateProcess），会遗留孤儿 pi 进程。必须 `taskkill /PID x /T /F` 整树终止。
- **bash 命令里的中文乱码**：Windows 控制台代码页会把 curl -d 的内联中文转 GBK → daemon 收到乱码。测试推送要用 node 脚本/文件保证 UTF-8。daemon 本身 UTF-8 无损（36 字符分毫不差验证过）。

## pi RPC 协议行为
- **agent_settled**：每个回合必然在 agent_end 之后到达；`agent_end.willRetry=true` 时不能立即结算回合（否则误报错误），要等重试后的 agent_end 或 settled。被拒 prompt（response success:false）不会产生 agent 事件，必须主动结算。
- **abort**：pi 中断回合时 agent_end 可能报 `aborted=false` 且无回复——要用自己的 pendingAbort 标记判定。兜底 timer 必须在 await 之前设置（否则竞态误杀下一回合）。
- **switch_session 恢复 cwd**：切换到其他项目的会话后，bash 的工作目录跟随会话（实测 obs-research 会话 → pwd 变成该目录）。因此 /resume 可以跨项目干活。
- **扩展命令比 registerTool 可靠**：pi 0.83 的 RPC 模式下 `getAllTools()` 返回空、`-e` 加载不稳定；扩展命令（registerCommand）通过 prompt 调用，流式中也立即执行。
- **UI confirm 桥接**：扩展 ctx.ui.confirm 在 RPC 模式发 extension_ui_request → 微信桥自动转发 → 用户回复确认/取消。可做审批，但用户嫌烦已回退（见下）。
- **消息队列**：读取 queue.jsonl 后不能删文件（否则强杀丢消息）；恢复后启动时要主动 flushQueue（否则永远不处理）。

## 用户习惯（重要）
- **讨论优先**：默认不自主执行工具/改文件，需要执行先询问。但**不要用硬性拦截**（approval-gate 扩展每次确认太烦，已回退）——提示词级软约束（requireApproval）即可，模型一般会遵守。
- **每完成一个大阶段自动 git commit + push**。
- 工作流：先评审 → 分阶段计划 → 实现 → 每阶段验证衔接。

## 微信 iLink API
- 发送消息支持 item_list 任意类型（text/image/file），URL 媒体可发；本地文件上传未验证。
- typing 指示：getConfig 取 typing_ticket，sendTyping status 1=输入中 2=取消；气泡几秒过期，长任务需心跳。
- 无效会话返回 errcode -14（session timeout），poller 重置游标即可。
- 群消息带 group_id；@提及检测需 botName 配置（OpenClaw bot 目前加不了群，未实测）。

## 测试教训
- **绝不覆盖 accounts.json**：测试假账号前必须先备份真实账号文件，用完全恢复（真实账号 token 结构：id / userId / botToken / baseUrl / createdAt）。
