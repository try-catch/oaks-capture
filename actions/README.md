# GitHub-hosted 采集

公共仓库仅包含采集代码、测试和目录定义。NDJSON、凭据、原始响应及未完成局只保存在测试服，禁止上传 artifact。

`workflow.yml` 发布为 `.github/workflows/capture.yml`。先取得 3 OAKS 对目标、频率和 GitHub Runner 出口的书面授权，再配置 Secrets；`OAKS_PROVIDER_AUTHORIZED` 只有在授权仍有效时才设为 `true`。先用 `workflow_dispatch / check` 验证，通过后设置仓库变量 `CAPTURE_ENABLED=true`。默认每 20 分钟运行一次，20 个 GitHub-hosted Linux 节点各自开启 8 个采集线程，每轮共享 45 分钟预算。

并发预算由协调器统一发放：`OAKS_THREADS × OAKS_NODES = 160` 个线程可以同时持有请求许可。每个线程独占一个游戏租约并持续恢复到配额达标或本轮预算耗尽，单次调用不再被 500 局截断。同屏线程数、节点数和请求间隔必须与服务商书面授权允许的并发一致；把 `OAKS_THREADS`、`OAKS_NODES`、`OAKS_SPIN_DELAY_MS` 调到授权上限之上属于超授权采集。

官方请求的节奏分两层：线程自身的 `OAKS_SPIN_DELAY_MS`（默认 2 秒）决定单个会话的请求间隔，节点层的 `OAKS_NODE_SPACING_MS`（默认 250 毫秒）保证同一出口不会在极短时间内连打。请求许可按到达顺序发放，正在退避的出口不会占用队首拖慢其它出口。

限速分两种反应。单个出口被限速时，只有该出口按官方 `Retry-After` 退避，其它出口继续工作。同一窗口（120 秒）内有 2 个及以上出口都被限速，说明是服务商整体限制，所有节点一起暂停；该截止时间持久化在 `output/.actions/queue.json`，后续运行继续遵守。

单节点熔断：同一节点内触发过官方限速的线程数超过 `OAKS_THROTTLE_LIMIT`（默认 6）时，判定该出口已被封控。协调器立即熔断该节点、交回它未完成的游戏租约，被熔断线程的后续落盘和确认会被拒绝。已写入测试服的数据全部保留，交回的游戏在下一次运行由新的节点接手，不需要人工干预。

会话恢复：官方把业务结果放在 HTTP 200 响应的 `status.code` 里，`GAME_REOPENED` 这类码表示当前会话已被重开。实测 7643 次请求里有 94 次是 `GAME_REOPENED`、19 次 `SERVER_ERROR`，属于正常运营事件，不是限速。出现这类码时只作废当前这一局（丢弃未完成帧）并重新登录，不再让整个游戏失败；只有结果未知的请求才继续走“隔离、禁止自动重放”的人工核实路径。协调器只重放调用方确认为业务成功的响应，业务失败的 200 会被重新请求，避免某一局被永久卡死。

每个游戏按代码中已核实的官方模式定义验收：普通模式至少 100000 条；每个购买模式和每个加注模式分别至少 10000 条。全部 107 款游戏合计约 1185 万局，在 160 线程 × 2 秒节奏下约需 2.5–3.2 天连续运行。

Secrets：`OAKS_SSH_KEY`、`OAKS_KNOWN_HOSTS`、`OAKS_SSH_HOST`、`OAKS_MONGO_HOST`、`OAKS_MONGO_URI`。Mongo URI 指向 Runner 的本地 SSH 隧道端口 27018，禁止开放数据库公网端口。SSH 主机密钥必须来自已核实的主机记录。采集 Runner 禁止配置任何 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 出口代理，也不轮换账号：节点只能是 GitHub-hosted Runner。

测试服先安装 `actions/coordinator.py`。旧采集容器必须停止，并存在 `output/actions-handoff.json` 交接证明。协调器每次放行官方请求前再次检查旧容器，跨运行队列所有权落盘于 `output/.actions/queue.json`。

每个请求先持久化意图，收到响应后立即持久化完整响应；未完成局保存会话、动作、已有帧。响应已保存但进程中断时重放已保存响应，不重新发出该请求。结果未知的请求会阻止自动重试，需要人工核实；不能声称外部接口支持未证实的幂等性。完整局先写测试服 NDJSON，再写 Mongo `simulate`，得到数据库确认后推进恢复点。恢复时按 sourceRoundHash 重建计数并同步 Mongo。

达到覆盖要求后立即执行 validate、audit-mongo --target test、finalize-data --target test。仅 accepted 状态可进入另行执行的资源与 Ops Agent 发布门禁；本 workflow 不直接启动游戏服务或改变发布状态。

如果 workflow 被强制取消而 finish 未能释放锁，下次 begin 使用当前 job 的只读 GitHub Token 查询旧 run/attempt；只有 GitHub 确认旧 attempt 已 completed 才回收队列所有权。Token 只通过 SSH 标准输入传递，不落盘。未知请求日志仍会阻止该请求自动重放，需要人工核实。禁止按计时器抢占未确认的请求或队列锁。

验证：`npm run check`、`npm test`、`python3 -m unittest discover -s actions -p 'test_*.py'`。这些测试使用合成协议与临时目录，不发真实采集请求。
