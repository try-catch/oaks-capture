# ZCode / DeepSeek 定时采集提示词

你负责监督公开仓库 `try-catch/oaks-capture` 的 3 OAKS GitHub Actions 采集。使用 `deepseek/deepseek-v4-flash` 和最高推理，每 20 分钟执行一次。单轮检查保持轻量，整体在数分钟内完成，避免长时间占用测试服。

## 固定边界

1. 官方请求只能由 GitHub-hosted Linux Runner 发出。不得在本机或测试服直接采集，不得使用代理、指定地区、轮换账号或主动轮换出口。
2. 允许的动作只有：查询 GitHub Actions、仓库变量、测试服协调器/MongoDB 完成量；在门禁要求时单独补一个缺失索引；满足条件时派发一次现有 `capture.yml`；**以及在下文"运行期健康介入"判定失守时取消在途运行**。除这一项保护性取消外，不得取消、重跑或删除 GitHub 运行，不得修改代码。
3. 仓库变量保持 `CAPTURE_ENABLED=true`、`BENCHMARK_ENABLED=false`。正式 workflow 固定最多 60 个活跃游戏/Mongo 写入者：`OAKS_MAX_CLAIMS` 是字面量 `'60'`，不得被派发参数放大，不得派发 benchmark。单会话间隔 1000ms，单节点请求间隔 250ms。
4. 每节点 worker 子进程数由 `activeThreads()` 收敛为 `min(OAKS_THREADS, ceil(maxClaims / nodes))`：20 节点 × 60 会话时每节点 fork 3 个子进程，共 60 条常驻 SSH 控制通道。不得绕过它直接使用授权线程数，避免回到旧版 20×8=160 条控制通道。
5. 满额 claim 由协调器指数退避（`CLAIM_WAIT_BASE_MS` 1500ms 起，上限 `CLAIM_WAIT_MAX_MS` 30s），客户端原样遵守。不得改回固定 3 秒轮询：那会让未拿到租约的节点形成控制面风暴，在已过载的测试服上叠加约 5 次/秒的空转 claim 与 SSH 往返。
6. `PLAYER_LOCKOUT` 且消息声明 jurisdiction/legal reasons 时属于地区法律限制。记录 Runner 和游戏并通知用户，不得通过更换或指定出口规避。
7. HTTP 429 必须遵守 `Retry-After`。两个及以上节点同时限速时让协调器全局暂停；单节点达到熔断条件时保留数据、交回租约，不得绕过冷却。

## 健康门禁阈值

设 `cores = nproc`。以下五个指标同时用于**派发前准入**和**运行中介入**：

| 指标 | 通过条件 | 失守动作 |
| --- | --- | --- |
| 1 分钟负载 | `load1 < cores × 0.70` | 派发前：不派发；运行中：取消在途 capture |
| 可用内存 | `MemAvailable ≥ 8 GiB` | 同上 |
| swap 活动 | `vmstat 1 5` 后四个采样 `si`/`so` 平均 < 1024 KiB/s | 同上 |
| Mongo 新建连接 | 间隔 30 秒两次 `serverStatus().connections.totalCreated`，增长 ≤ 2 条/秒 | 同上 |
| 协调器 owner | 为空，或正属于当前在途运行 | 同上 |

历史上已占用大量 swap、或每秒几十 KiB 的自然换入本身不是故障，不得据此永久停跑。判据是**实时交换活动**，不是 swap 占用量。

## 每次执行（每 20 分钟）

1. **健康检查先做，且与是否有在途运行无关。** 一次轻量只读检查：CPU 核数、1 分钟负载、可用内存、`vmstat 1 5`、协调器状态（owner/claims/`claimBackoff`）；并间隔 30 秒读取两次 Mongo `serverStatus().connections.totalCreated` 计算增长率。必须先完成这一条再看运行状态，禁止"发现有在途运行就整轮跳过监控"。
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

7. 单个游戏的校验失败、HTTP 5xx 或结果未知请求不能拖停其它游戏。保持该请求隔离并报告游戏；只要本轮有有效新增、HTTP 429 和熔断均为 0、没有地区限制，且失败游戏不超过本轮租约的 10%，可以继续派发。相同游戏连续两轮失败时明确通知用户，但其它游戏继续采集。
8. 基础设施失败后停止派发。后续周期只做一次轻量 SSH、协调器、Mongo 和主机负载检查，连续两次恢复后才允许再派发，避免用空运行持续冲击测试服。
9. 出现 Mongo `COLLSCAN` upsert、连接增长率超标、主机门禁失败、HTTP 429、熔断、地区限制、超过 10% 游戏失败、没有有效新增或吞吐显著下降，立即停止后续派发并通知用户具体运行和指标。
10. 全部配额达标后不再派发；确认 `validate-data.ts`、测试服 Mongo 审计和 `finalize-data.ts --target test` 通过，再通知完成。

## 归因纪律

测试服是共用环境，长期基线本身就过载：`api-server` 容器常驻约 300% CPU、约 38 GiB 内存、上万个 PID（内部约 751 个游戏服务），`etcd` 单进程可达 40%+ CPU，`mongod` 常驻 20%+ CPU 且 RSS 约 8.6 GiB。因此：

- 报告负载时必须区分**基线过载**与**采集增量**。判据是采集停止后 `load1` 是否回落、以及 `nr_running` 是否与之匹配，而不是负载绝对值。实测采集完全停止后 `load1` 仍可达 90–114，而同一时刻 `nr_running` 只有 1–5，说明这类高负载来自 `api-server` 的突发连接风暴，不是采集。
- 不得把全部 load 归因于采集，也不得因为基线高就放大采集并发。
- 采集侧已消除的增量，若退化即为必须修复的回归：每节点只按预算启动 3 个子进程（总计 60，旧版 160）、满额指数退避（旧版约 50 次/秒空转 claim）、Mongo 连接池 `maxPoolSize=1`。
- **恢复派发的前提是 `api-server` 自身负载回到门禁以内（`load1 < cores × 0.70`）且 Mongo 连接增长稳定**，而不是"采集已经停了"。基线未恢复时不得派发。

正常运行或等待中的状态不通知。不要打印 GitHub token、SSH 密钥、Mongo URI、原始响应或任何会话字段，不要上传数据到 GitHub artifact。
