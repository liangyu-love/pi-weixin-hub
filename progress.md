# Progress: pi-weixin-hub 开发进度日志

<!-- 按阶段记录完成情况与提交。更新时间：2026-08-03 -->

## 2026-08-03 — 全部主要阶段完成并上线

### Phase 0: 基础重构（提交 d378d54、980f30f）
- 改名 pi-weixin-hub v0.4.0，配置扩展，持久会话，分级日志，自适应视觉，回复格式化，错误分类
- 评审修复：abort 语义、下载单次化、词边界正则、TDZ、URL/emoji 拆分、pi 路径解析（Windows）

### Phase 1: 多会话路由 + 快捷命令（提交 828c675）
- 每用户会话隔离、UI 归属保护、/image /search /model /status

### Phase 2: 防刷 + 仪表盘（提交 d2b34bb，v0.5.0）
- 限流/黑名单/通知合并、daemon 心跳 + status 面板

### Phase A: 输出通道（提交 aa83dc8）
- agent_settled 修复、typing 心跳、URL 媒体回复、被拒 prompt 处理

### Phase B: 主动推送（提交 393b2b7）
- webhook API + Pi 扩展包（weixin-send 等）、UTF-8 验证

### Phase C: 上下文（提交 fbf6d34）
- 消息增强、人设/memory 注入、自动压缩

### Phase D: 可靠性（提交 2a3feb4）
- doctor、轮转日志、保留清理、持久队列

### Phase E: 成本控制（提交 5262faf）
- /usage、costAlert、userModels、--fork

### 实测修复轮（提交 8380d0b、fbbf131、54d3ef4、e5c429d、2df1319、9c583a8、95aa125、ddd6db3、1e271a5）
- windowsHide（daemon + pi 子进程）、stop 整树终止
- abort 竞态修复（timer 先于 await、不重复确认）
- 队列恢复自动处理、队列持久性（不删文件）
- typing 心跳、通知去重
- 执行规则 requireApproval（提示词级；硬拦截已回退）
- 定时任务调度器（schedules）
- 文档转换（document-converter.ts + markitdown 扩展入库）

### 实机验证（真实微信账号 4323498a982f@im.bot）
- 文本全链路、图片自适应视觉（subagent 实锤）、长回复拆分、/model 切换、
  /session /usage /status、webhook 推送（文本/图片/通知）、会话持久化、调度器
- 生产配置：logLevel=info、webhook 8787（自动 token）、logFile=e2e.log、requireApproval=true、schedules={"8:00":"push:⏰ 该起床啦…"}

## 当前状态
- daemon 后台运行（--fork 无窗口），日常使用中
- 仓库 HEAD 与 origin/main 同步
