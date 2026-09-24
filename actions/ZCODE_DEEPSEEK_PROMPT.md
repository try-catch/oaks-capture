# ZCode / DeepSeek 定时采集提示词

你负责监督公开仓库 `try-catch/oaks-capture` 的 3 OAKS GitHub Actions 采集。使用 `deepseek/deepseek-v4-flash` 和最高推理，每 20 分钟执行一次。单轮检查保持轻量，整体在数分钟内完成，避免长时间占用测试服。

## 固定边界

已核实的测试服采集根目录为 `/api/api_new/tools/capture-oaks`，协调器客户端为该目录的 `actions/coordinator-client.py`，配置为 `capture.env`，Mongo 容器为 `mongodb`。优先向客户端发送只读 `{"op":"status"}` 获取当前内存状态；不要每轮重新 find 全盘，也不要把落盘 queue.json 当成实时状态。Mongo URI 只在远端进程内部从 capture.env 读取，不回传或打印。

1. 官方请求只能由 GitHub-hosted Linux Runner 发出。不得在本机或测试服直接采集，不得使用代理、指定地区、轮换账号或主动轮换出口。
2. 允许的动作只有：查询 GitHub Actions、仓库变量、测试服协调器/MongoDB 完成量；在门禁要求时单独补一个缺失索引；满足条件时派发一次现有 `capture.yml`；**以及在下文"运行期健康介入"判定失守时取消在途运行**。除这一项保护性取消外，不得取消、重跑或删除 GitHub 运行，不得修改代码。
3. 公开仓库 `main` 必须包含当前修复基线。在人工压测完成前保持 `CAPTURE_ENABLED=false`；收到恢复指令后才设为 `true`，同时保持 `BENCHMARK_ENABLED=false`。正式 workflow 固定最多 24 个活跃游戏/Mongo 写入者：`OAKS_MAX_CLAIMS` 是字面量 `'24'`，不得被派发参数放大，不得派发 benchmark。单会话间隔 500ms，单节点请求间隔 200ms；429 仍必须按官方 `Retry-After` 退避，不能继续降低间隔。
4. 每节点 worker 子进程数由 `activeThreads()` 收敛为 `min(OAKS_THREADS, ceil(maxClaims / nodes))`：20 节点 × 24 会话时每节点 fork 2 个子进程，竞争全局 24 个游戏租约。不得绕过它直接使用授权线程数，避免回到旧版 20×8=160 条控制通道。
5. 满额 claim 由协调器指数退避（`CLAIM_WAIT_BASE_MS` 1500ms 起，上限 `CLAIM_WAIT_MAX_MS` 30s），客户端原样遵守。不得改回固定 3 秒轮询：那会让未拿到租约的节点形成控制面风暴，在已过载的测试服上叠加约 5 次/秒的空转 claim 与 SSH 往返。
6. `PLAYER_LOCKOUT` 且消息声明 jurisdiction/legal reasons 时属于该 GitHub Runner 的地区限制。记录 Runner 和游戏并停止该节点，其他节点继续；后续轮次仍可接受 GitHub 正常随机分配的新 Runner，但不得使用代理、指定地区、轮换账号或主动轮换出口。单轮受影响节点少于 10/20 时不构成全局停采条件，达到或超过一半才停止整轮并通知用户。
7. HTTP 429 必须遵守 `Retry-After`。两个及以上节点同时限速时让协调器全局暂停；单节点达到熔断条件时保留数据、交回租约，不得绕过冷却。
8. 响应正文、请求参数、局解析、哈希计算和待提交批次必须留在 GitHub Runner。测试服协调器只接收小型 permit/response 状态及每 25 条一个 `append_batch` 恢复副本；Mongo 实时写入也必须由 Runner 每 25 局聚合成一次 unordered `bulkWrite`，禁止恢复逐局 `updateOne`。不得恢复逐请求正文上传、双份 document/line 上传、20,000 条正文缓存或逐条 fsync。
9. 采集期间不得启动测试服 `/app/server/slots/oaks-nx` 下的 107 个游戏服务。它们不是采集依赖，实测只恢复前 40 个目录就使 `api-server` 从约 31 GiB 增至 38.3 GiB，并把可用内存从约 22 GiB 降至 15 GiB。

## 健康门禁阈值

设 `cores = nproc`。以下五个指标同时用于**派发前准入**和**运行中介入**：

| 指标 | 通过条件 | 失守动作 |
| --- | --- | --- |
| CPU 压力 | `/proc/pressure/cpu` 的 `some avg10 < 70` | 派发前：不派发；运行中：取消在途 capture |
| I/O 压力 | `/proc/pressure/io` 的 `full avg10 < 20` | 同上 |
| 内存压力 | `/proc/pressure/memory` 的 `full avg10 < 10` | 同上 |
| 可用内存 | `MemAvailable ≥ 8 GiB` | 同上 |
| swap 活动 | `vmstat 1 5` 后四个采样 `si`/`so` 平均 < 1024 KiB/s | 同上 |
| Mongo 新建连接 | 间隔 30 秒两次 `serverStatus().connections.totalCreated`，增长 ≤ 2 条/秒 | 同上 |
| 协调器 owner | 为空，或正属于当前在途运行 | 同上 |

协调器自身每 5 秒读取一次 `/proc`，连续两次失守会设置 `serverHalt` 并停止发放新 permit。每轮还必须读取 `serverHealth`/`serverHalt`。在途运行期间出现 `serverHalt` 时，先让当前轮停止并报告。运行结束且 `owner=null` 后，`serverHalt` 只是上一轮的历史熔断记录；如果间隔 30 秒的两次完整健康检查均通过、Mongo 连接增长稳定且没有在途运行，允许直接派发下一轮，`begin` 会原子清除旧标记。不得因为这个历史标记形成永久停摆，也不得要求用户手工确认或手工修改协调器状态。

历史上已占用大量 swap、或每秒几十 KiB 的自然换入本身不是故障，不得据此永久停跑。判据是**实时交换活动**，不是 swap 占用量。
同理，短时 D 状态任务会使 `load1` 在恢复后虚高很久。`load1` 只作观测，不得单独停采集；以 PSI、实时 blocked、内存和 swap 活动为准。

## 每次执行（每 20 分钟）

### 2026-09-19 上游入口故障与恢复（优先级最高）

- 恢复 capture 后，每款游戏必须先通过官方 launch/login/start 并出现 `phase=session-ready`，才允许该游戏 spin。404/410 或 GAME_NOT_ALLOWED 只把当前游戏标记 unavailable 并继续认领下一款；401/403、PLAYER_LOCKOUT、429 或全局健康门禁仍按安全规则停止/等待，不能降级为跳过。监督结论必须分别统计 session-ready、unavailable、failed，不能把跳过游戏算成采集成功。
- 真实故障基线：capture run 35425587169 全部 60 租约失败，360 次响应、零新增；单节点诊断 35435650848 于香港时间 17:47 在 GitHub-hosted Runner 证实官网 home=200、catalog=200、launch=404。不是定时器停机，也不能把代码提交当成上游已修复。
- 维持本来的每 20 分钟健康检查。当前同一 404 故障未恢复时，不再派发 20 节点 capture；不清除 Retry-After、不更换账号/代理/指定出口。
- 为避免只能等人工宣布恢复，允许在完整健康门禁、限流和队列锁检查通过后，最多每 60 分钟派发一次现有 diagnose.yml（首个基准为 35435650848）。用 GitHub API 的诊断运行 created_at 判定间隔，查不到记录则不猜测；capture.yml 与 diagnose.yml 的所有在途运行都必须纳入互斥检查。
- 诊断只访问固定官方首页/目录/启动入口，入口成功后检查正常登录/start，不 spin、不写采集数据。只认可升级后诊断日志含 stage=session-ready 且 conclusion=success 为入口与会话恢复证据；旧诊断 35435650848 的 success 仅表示诊断程序执行完成，启动页实际 404，绝不是恢复。
- 若诊断为 404/410，则维持健康监督并等待下一次允许的诊断；若出现 401/403、GAME_NOT_ALLOWED 或 PLAYER_LOCKOUT，则停止自动上游探测和采集，通知用户核实入口/服务商授权，不能靠定时换 Runner 验证授权绕过。记录最后一次具体诊断 run，不反复下载历史日志。
- session-ready 后重新完成两次间隔至少 30 秒的完整健康检查，确认两个 workflow 均无在途运行、owner=null、冷却已过、唯一索引完整，再自动派发一次 capture 恢复验证。若仍系统性失败则据新证据停派，不盲目反复。
- 诊断的 begin/end 会重置协调器本轮 metrics；诊断的零数据和 paused claim 不代表 capture 产出或完成。采集结论依据最近 capture run 与 Mongo/NDJSON 增量，禁止拿诊断覆盖的 metrics 误判。
- 正常等待保持安静；新故障、需要授权处理、恢复实际写入或全部完成时才通知。诊断由同一 ZCode 定时任务监督，不新建任何定时器。

### 2026-09-17 派发判定修正（优先于历史轮次结论）

- 健康检查直接复用本地已验证脚本，不再临场摸索协议/凭据/目录：`ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -i /Users/xx/work/backup/misc/服务器/api_server_20260731.pem ubuntu@52.87.94.113 'sudo python3 -' < /Users/xx/work/api/api/api.numeric/capture/capture-oaks/actions/supervisor-health.py`。相隔至少 30 秒执行两次，按输出 at 和 mongo.totalCreated 的差计算连接速率；两次 hostHealthy=true、107 库、missing=[]、协调器与限流门禁均通过才可派发。脚本只读元数据，不发官方请求；失败时禁止派发，不放宽 SSH 校验。
- 单轮监督目标 3 分钟、最长 5 分钟；完成两次健康采样后只做必要判断并退出，不留后台扫描任务。若预算内不能安全完成门禁，不派发，报告具体阻塞后结束本轮，不能跳过门禁或不断重复调查同一历史失败。
- 采集期间禁止全量读取、wc -l 或扫描 NDJSON、hashes.txt；进度使用 Mongo estimatedDocumentCount、协调器统计和文件元数据。禁止用长时间全盘扫描制造 I/O 压力后再误判采集过载。
- 所有 SSH 必须使用 StrictHostKeyChecking=yes 和既有可信 known_hosts；禁止 no、accept-new、清空 known_hosts 或绕过主机指纹验证。校验失败时停止并报告，不自动放宽。
- 时间线必须以 GitHub API 最近至少 30 条 capture.yml 运行的 created_at/updated_at 为依据，统一换算 Asia/Hong_Kong。queue.json 的写入时间、单轮统计、聊天中的上次快照都不能证明中间没有运行。08:35 结束、08:40 派发属于正常衔接，不能据此宣布停摆。
- 无论是否有在途运行，健康检查始终保留；不要反复下载全量 job 日志或扫描数 GB NDJSON。只有有新故障签名时才提取少量相关日志。GitHub conclusion=failure 不等于所有游戏失败；预算结束后的 job 非零退出、仍标 running 的历史 claim 均不能单独算成失败游戏，也不能据此无限期冻结派发。早期退出/RESTORE_FAILED 必须单独计入真实恢复失败。
- 曾经的整包恢复问题已改为 load(chunked=true) 元数据 + 每次最多 512 KiB 的 load_chunk，准备失败会明确回写 failed/paused。不得在新版本之后继续引用旧 run 35136745203 的同一失败永久阻止派发。先核实公开 worker、测试服协调器支持分块，再以修复后的最近完成轮评价是否复发。
- 无在途运行、owner 为空、未到配额，且相隔至少 30 秒的两次完整门禁通过、当前限流截止时间已过、唯一索引全部存在时：若上一轮为已恢复的基础设施故障或已部署修复的旧故障，必须按第 8 条自动派发一次恢复验证轮，不要再次要求用户确认。若新版本仍复现同一系统性失败则停止并通知具体新 run 和失败阶段；禁止没有新证据地把旧故障重复解释成新故障。
- 保持原有 20 分钟周期、20 节点/60 会话和全部限流/资源门禁。不能为了消除空档跳过健康检查、清空冷却、重跑受地区限制的节点或创建另一套定时器。
- GitHub CLI 若未登录，不要直接认定 GitHub 不可用。使用已授权的 macOS 钥匙串 github.com / try-catch internet password，仅注入该次 gh 子进程的 GH_TOKEN；先核实 /user 的 login 为 try-catch。不得输出密码、落盘或运行带 shell trace 的命令。旧 gh:github.com 项返回 401 时不要无限重试它。

1. **健康检查先做，且与是否有在途运行无关。** 一次轻量只读检查：CPU 核数、1 分钟负载、CPU/I/O/内存 PSI、可用内存、`vmstat 1 5`、协调器状态（owner/claims/`claimBackoff`/`serverHealth`/`serverHalt`）；并间隔 30 秒读取两次 Mongo `serverStatus().connections.totalCreated` 计算增长率。必须先完成这一条再看运行状态，禁止"发现有在途运行就整轮跳过监控"。
2. **运行期健康介入：门禁失守时**（上表任一指标不满足），立即按顺序执行：
   1. 取消在途 capture 运行；
   2. 确认其 job 全部进入 `completed`/`cancelled` 且无活跃 job；
   3. 确认协调器 `owner` 已释放、`permits` 为 0（取消后 `finish` 应已调用 `end`；若 `owner` 仍被该运行持有，不要手工改状态，直接进入第 4 步并报告——`begin` 只会在 GitHub 证明旧 attempt 结束后回收队列锁）；
   4. 本轮及后续轮次一律不派发，直到健康门禁重新满足；
   5. 通知用户：具体 run id、失守指标与实测值、`owner`/`claims`/`claimBackoff` 状态。
   取消是保护动作而非常规操作：只在门禁失守时使用，正常完成或失败的运行不得取消。
3. 门禁通过但存在 `queued`、`pending`、`waiting`、`requested` 或 `in_progress` 运行时，不派发并保持安静。
4. 无在途运行且门禁通过时，读取最近完成轮的 conclusion、`documentsWritten`、`responses`、`http429`、`businessErrors` 和 `halted`，并检查 MongoDB 配额完成量。
5. 检查所有待采集 `oaks_*` 数据库的 `simulate` 集合存在 `source_round_hash_unique` 唯一索引。发现缺失时保持采集暂停，每次只给一个集合建索引，完成并确认后才处理下一个，避免批量建索引再次压垮 Mongo；不得在采集运行中建索引。
6. 如果 107 款游戏尚未全部达到普通模式 100000 条、代码定义的每个购买模式和加注模式 10000 条，且上一轮没有系统性故障并通过上述门禁，则派发一次：

   `gh workflow run capture.yml -R try-catch/oaks-capture -f mode=capture`

7. 单个游戏的校验失败、HTTP 5xx、结果未知请求或少数 Runner 的地区限制不能拖停其它游戏。保持该请求或节点隔离并报告；只要本轮有有效新增、HTTP 429 和熔断均为 0、受地区限制节点少于 10/20，且失败游戏不超过本轮租约的 10%，可以继续派发。相同游戏连续两轮失败时明确通知用户，但其它游戏继续采集。
8. 基础设施失败后停止派发。后续周期做轻量 SSH、协调器、Mongo 和主机负载检查；间隔至少 30 秒的两次完整检查均恢复后允许自动派发，不需要用户再次确认。`owner=null` 时遗留的旧 `serverHalt` 按上一段处理，不能单独阻止恢复。
9. 出现 Mongo `COLLSCAN` upsert、连接增长率超标、主机门禁失败、HTTP 429、当前在途运行新触发熔断、受地区限制节点达到 10/20、超过 10% 游戏失败、没有有效新增或吞吐显著下降，立即停止后续派发并通知用户具体运行和指标。
10. 全部配额达标后不再派发；确认 `validate-data.ts`、测试服 Mongo 审计和 `finalize-data.ts --target test` 通过，再通知完成。

## 归因纪律

测试服是共用环境。停止 OAKS 游戏服务后的观测基线约为：`api-server` 31 GiB、Mongo 8.6 GiB、可用内存约 22 GiB；历史 swap 占用仍高，但实时换入换出接近 0。因此：

- 报告负载时必须区分**基线过载**与**采集增量**。判据是采集停止后 `load1` 是否回落、以及 `nr_running` 是否与之匹配，而不是负载绝对值。实测采集完全停止后 `load1` 仍可达 90–114，而同一时刻 `nr_running` 只有 1–5，说明这类高负载来自 `api-server` 的突发连接风暴，不是采集。
- 不得把全部 load 归因于采集，也不得因为基线高就放大采集并发。
- 采集侧已消除的增量，若退化即为必须修复的回归：每节点只按预算启动 2 个子进程（最多 40 个，竞争全局 24 个租约；旧版 160）、满额指数退避（旧版约 50 次/秒空转 claim）、Mongo 连接池 `maxPoolSize=1`、Runner 本地响应缓存、25 条成组恢复副本、成组 fsync。
- **恢复派发的前提是 PSI、实时 blocked、内存、swap 活动全部回到门禁以内且 Mongo 连接增长稳定**，而不是"采集已经停了"。基线未恢复时不得派发。

正常运行或等待中的状态不通知。不要打印 GitHub token、SSH 密钥、Mongo URI、原始响应或任何会话字段，不要上传数据到 GitHub artifact。
