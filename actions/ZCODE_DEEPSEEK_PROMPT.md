# 给 ZCode / DeepSeek 的执行提示词

你在处理 3 OAKS 数据采集工具仓库。先完整阅读 `README.md`、`.github/workflows/capture.yml`、`actions/worker.ts`、`actions/coordinator.py` 和 `games/registry.json`，然后按下面要求执行。

1. 不重写采集核心，不添加代理，不轮换出口，不增加规避限流的并发。20 个 GitHub-hosted Runner 只负责领取不同游戏；所有官方 HTTP 请求必须经过测试服协调器的全局单请求锁。单个 Runner 每次只采一个游戏。
2. 只有已经取得 3 OAKS 对采集目标、频率及 GitHub Runner 出口的书面授权时，才把 GitHub Secret `OAKS_PROVIDER_AUTHORIZED` 设置为 `true`。没有授权时只运行 `workflow_dispatch` 的 `check`，不得运行 `capture`。
3. 配置 GitHub Secrets：`OAKS_SSH_KEY`、`OAKS_KNOWN_HOSTS`、`OAKS_SSH_HOST`、`OAKS_MONGO_HOST`、`OAKS_MONGO_URI`、`OAKS_PROVIDER_AUTHORIZED`。不要打印或提交这些值，不要开放 MongoDB 公网端口。
4. 先在测试服停止旧采集容器，并确认 `/api/api_new/tools/capture-oaks/output/actions-handoff.json` 的 `migrationState` 为 `stopped`。把本仓库的 `actions/coordinator.py` 部署到 `/api/api_new/tools/capture-oaks/actions/coordinator.py`，保留测试服已有 `output` 数据。
5. 本地运行 `npm ci --ignore-scripts --no-audit --no-fund`、`npm run check`、`npm test`、`python3 -m unittest discover -s actions -p 'test_*.py'`。任何失败都先修复，不得跳过。
6. 先手动运行 `check`，确认 SSH 主机指纹、Mongo SSH 隧道和测试服协调器通过。随后只做一个短时 Canary，核对测试服 NDJSON 与 Mongo 的 `sourceRoundHash` 数量一致、无敏感字段、普通输赢均存在，再启用定时采集。
7. 最终目标由工具固定验收：每个启用游戏普通模式至少 100000 条；代码声明的每个购买模式和每个加注模式分别至少 10000 条。只补缺口，断点续跑，`sourceRoundHash` 唯一键去重。达到目标后必须通过 `validate-data.ts`、`audit-mongo.ts --target test` 和 `finalize-data.ts --target test` 才能标记完成。
8. 收到 429 时严格等待 `Retry-After`，整个跨节点队列一起暂停。若没有 `Retry-After`，沿用协调器的保守等待。不得用新节点、新账号、新出口或缩短间隔继续请求。
9. 数据和原始响应只放测试服；不要上传 GitHub artifact，不要提交 `output/`、`seed-data/`、`.env`、密钥或 Mongo 连接串。
10. 完成后报告：提交哈希、工作流运行链接、授权检查结果、每个游戏各模式的目标/当前/缺口、429 次数与实际等待、NDJSON/Mongo 去重校验结果、失败或被隔离的未知请求。不要声称未验证的数据已经完成。

如果现有实现与这些约束冲突，优先修复约束和测试；不要把 20×8 改成 160 路官方并发。
