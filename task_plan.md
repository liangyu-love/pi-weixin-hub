# Task Plan: pi-weixin-hub — 微信 ↔ Pi 双向桥接（已上线，持续演进）

<!-- 磁盘上的工作记忆：目标、阶段、下一步。更新于 2026-08-03 -->

## Goal
让 pi-weixin-hub 稳定服务日常微信↔Pi 双向通信：消息收发、图片/文档智能处理、主动推送、定时任务、会话管理，全部经真实账号验证并已上线。

## Next Step
（当前无进行中任务）下一次开发/维护时：先读本文件 + findings.md + progress.md 恢复上下文，再继续。

## Current Phase
全部主要阶段已完成（生产运行中）。剩余可选事项见 Pending。

## Phases

### Phase 0: 基础重构（原计划 Step 1–7） ✅ complete
- [x] 项目改名 pi-weixin-hub（v0.4.0，双 bin 名）
- **Status:** complete

- [x] 配置扩展：defaultModel / allowlist / groupChat / maxReplyLength / replyPrefix / logLevel / persistentSession / visionAgent / attachImages / botName
- [x] 持久会话（每用户 sessions.json + 懒切换 + 旧文件迁移）
- [x] 分级日志（debug/info/warn/error，LOG_LEVEL 覆盖）
- [x] 自适应视觉（检测 model.input：视觉模型直接附加 / 文本模型走 vision 子代理）
- [x] 回复格式化（markdown→微信、长文本拆分）
- [x] 分类错误提示（429/timeout/permission/model/server/network）
- [x] 评审修复（abort 语义、下载单次化、词边界正则、TDZ、URL/emoji 安全拆分、pi 路径解析）

### Phase 1: 多会话路由 + 快捷命令（原计划 Step 8–9） ✅ complete
- [x] 每用户会话隔离（私聊=默认，群聊=按发送者，@botName 触发）
- **Status:** complete

- [x] UI 对话框归属保护（只接受回合所有者回复）
- [x] /image /search /model <name> /status 命令

### Phase 2: 防刷 + 状态面板（原计划 Step 10–12） ✅ complete
- [x] 限流（rateLimitMax）、黑名单、通知合并缓冲
- **Status:** complete

- [x] daemon-status.json 心跳 + `status` 终端仪表盘

### Phase A: 回复正确性 + 输出通道 ✅ complete
- [x] agent_settled/willRetry 最终回复（修复重试误报）
- **Status:** complete

- [x] typing 指示（含 5s 心跳保持）
- [x] URL 媒体回复（outbox 清单 + /send-image /send-file）
- [x] 被拒 prompt 立即回错误（不再干等）

### Phase B: Pi 主动出击 ✅ complete
- [x] 本地 webhook（/send /notify /media，Bearer 令牌，仅回环）
- **Status:** complete

- [x] Pi 扩展包（weixin-send/weixin-media 命令；工具按官方 API 注册）
- [x] 微信消息内容确认（UTF-8 无损）

### Phase C: 上下文与连续性 ✅ complete
- [x] 消息增强（群归属 + 引用消息）
- **Status:** complete

- [x] 人设 + memory.md 长期记忆注入
- [x] 自动压缩（autoCompactThreshold）

### Phase D: 可靠性 ✅ complete
- [x] doctor 自检
- **Status:** complete

- [x] 轮转日志文件（logFile/logMaxBytes）
- [x] 媒体/会话保留清理（retentionDays）
- [x] 崩溃恢复消息队列（queue.jsonl + TTL + 启动自动处理）

### Phase E: 成本与模型控制 ✅ complete
- [x] /usage 用量统计 + costAlert
- **Status:** complete

- [x] userModels 每用户模型映射
- [x] --fork 无窗口后台运行 + stop 命令

### Phase F: 后续增强 ✅ complete（视用户需求可继续）
- [x] 定时任务调度器（schedules：HH:MM 每天 / every:N 分钟；push:前缀=直接推送，否则注入 pi）
- [x] 文档自动转换（MarkItDown：管道 document-converter.ts + 全局 convert_document 扩展）
- [x] 执行规则（requireApproval 提示词级软约束；硬拦截已回退）
- [ ] 群聊实测（OpenClaw bot 暂不能加群，待验证）
- [ ] 自动化测试套件（node:test 覆盖纯函数模块）
- [ ] 文档转换 README 说明
- **Status:** complete

## Pending（可选）
- 群聊路由实测
- 自动化测试（format-reply / error-classifier / context / storage 已具备测试条件）
- README 补充文档转换功能说明
