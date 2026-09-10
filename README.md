# GitHub-hosted 采集

公共仓库仅包含采集代码、测试和目录定义。NDJSON、凭据、原始响应及未完成局只保存在测试服，禁止上传 artifact。

`workflow.yml` 发布为 `.github/workflows/capture.yml`。先配置 Secrets，再用 `workflow_dispatch / check` 验证；通过后设置仓库变量 `CAPTURE_ENABLED=true`。默认每小时第 17 分钟运行，20 个 GitHub-hosted Linux 节点从同一队列领取游戏，每款每轮最多 500 局，共享 40 分钟预算。

20 个节点不会获得 20 倍请求额度。协调器同时只允许一个官方请求，普通间隔 3 秒，重复 429 后间隔 5 秒；所有节点和后续运行共用持久化的 Retry-After 截止时间。切换游戏等待 10 秒。

同时活跃的游戏会话最多 6 个，其余节点等待领取，不提前登录官方。已观测到请求间隔 61–62 秒时返回 `GAME_REOPENED`，因此不能让 20 个会话同时竞争共享节流。6 个是保守运行上限，不代表已确认官方超时阈值；已领取游戏结束后自动释放位置。

Secrets：`OAKS_SSH_KEY`、`OAKS_KNOWN_HOSTS`、`OAKS_SSH_HOST`、`OAKS_MONGO_HOST`、`OAKS_MONGO_URI`。Mongo URI 指向 Runner 的本地 SSH 隧道端口 27018，禁止开放数据库公网端口。SSH 主机密钥必须来自已核实的主机记录。

测试服先安装 `actions/coordinator.py`。旧采集容器必须停止，并存在 `output/actions-handoff.json` 交接证明。协调器每次放行官方请求前再次检查旧容器，跨运行队列所有权落盘于 `output/.actions/queue.json`。

每个请求先持久化意图，收到响应后立即持久化完整响应；未完成局保存会话、动作、已有帧。响应已保存但进程中断时重放已保存响应，不重新发出该请求。结果未知的请求会阻止自动重试，需要人工核实；不能声称外部接口支持未证实的幂等性。完整局先写测试服 NDJSON，再写 Mongo `simulate`，得到数据库确认后推进恢复点。恢复时按 sourceRoundHash 重建计数并同步 Mongo。

达到覆盖要求后立即执行 validate、audit-mongo --target test、finalize-data --target test。仅 accepted 状态可进入另行执行的资源与 Ops Agent 发布门禁；本 workflow 不直接启动游戏服务或改变发布状态。

如果 workflow 被强制取消而 finish 未能释放锁，下次 begin 使用当前 job 的只读 GitHub Token 查询旧 run/attempt；只有 GitHub 确认旧 attempt 已 completed 才回收队列所有权。Token 只通过 SSH 标准输入传递，不落盘。未知请求日志仍会阻止该请求自动重放，需要人工核实。禁止按计时器抢占未确认的请求或队列锁。

验证：`npm run check`、`npm test`、`python3 -m unittest discover -s actions -p 'test_*.py'`。这些测试使用合成协议与临时目录，不发真实采集请求。
