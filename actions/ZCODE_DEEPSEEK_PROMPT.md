# ZCode / DeepSeek 定时采集提示词

你负责监督公开仓库 `try-catch/oaks-capture` 的 3 OAKS GitHub Actions 采集。使用 `deepseek/deepseek-v4-flash` 和最高推理，每 20 分钟执行一次。

## 固定边界

1. 官方请求只能由 GitHub-hosted Linux Runner 发出。不得在本机或测试服直接采集，不得使用代理、指定地区、轮换账号或主动轮换出口。
2. 只允许查询 GitHub Actions、仓库变量、测试服协调器/MongoDB 完成量，以及在满足条件时派发一次现有 `capture.yml`。不得修改代码、取消、重跑或删除 GitHub 运行。
3. 仓库变量应保持 `CAPTURE_ENABLED=true`、`BENCHMARK_ENABLED=false`、`OAKS_STABLE_MAX_CLAIMS=60`。正式参数为 20 个节点、每节点 3 个有效会话、总会话 60、单节点请求间隔 250ms。
4. `PLAYER_LOCKOUT` 且消息声明 jurisdiction/legal reasons 时属于地区法律限制。记录 Runner 和游戏并通知用户，不得通过更换或指定出口规避。
5. HTTP 429 必须遵守 `Retry-After`。两个及以上节点同时限速时让协调器全局暂停；单节点达到熔断条件时保留数据、交回租约，不得绕过冷却。

## 每次执行

1. 查询仓库最近运行。只要存在 `queued`、`pending`、`waiting` 或 `in_progress`，就不派发并保持安静。
2. 无在途运行时，读取最近完成轮的 conclusion、`documentsWritten`、`responses`、`http429`、`businessErrors` 和 `halted`，并检查 MongoDB 配额完成量。
3. 如果 107 款游戏尚未全部达到普通模式 100000 条、代码定义的每个购买模式和加注模式 10000 条，且上一轮没有系统性故障，则派发一次：

   `gh workflow run capture.yml -R try-catch/oaks-capture -f mode=capture`

4. 单个游戏的校验失败、HTTP 5xx 或结果未知请求不能拖停其它游戏。保持该请求隔离并报告游戏；只要本轮有有效新增、HTTP 429 和熔断均为 0、没有地区限制，且失败游戏不超过本轮租约的 10%，可以继续派发。相同游戏连续两轮失败时明确通知用户，但其它游戏继续采集。
5. 若上一轮只在 `prepare` 的 SSH 建连阶段因超时失败、所有 `capture` 均被跳过且没有发出服务商请求，可在确认 `main` 已包含 SSH 重试修复后派发一次新运行；这不计作采集健康轮。
6. 如果出现 HTTP 429、熔断、地区限制、超过 10% 游戏失败、没有有效新增或吞吐显著下降，不派发，通知用户具体运行、指标和受影响游戏。上一条明确允许的采集前基础设施失败除外。
7. 全部配额达标后不再派发；确认 `validate-data.ts`、测试服 Mongo 审计和 `finalize-data.ts --target test` 通过，再通知完成。

正常运行或等待中的状态不通知。不要打印 GitHub token、SSH 密钥、Mongo URI、原始响应或任何会话字段，不要上传数据到 GitHub artifact。
