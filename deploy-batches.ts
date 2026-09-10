import crypto from "node:crypto";
import { STATIC_TARGET } from "./config";
import fs from "node:fs/promises";
import path from "node:path";
import { readRegistry } from "./catalog-sync";
import { numberOption, stringOption } from "./src/cli";
import { buildDeployPlan, capacityGate, DeployPlan, DeployReadiness, mergeDeploymentProgress } from "./src/deploy-plan";

interface AgentResponse<T> { ok: boolean; data?: T; message?: string }
interface AgentOperation { id: string; status: "queued" | "pending" | "running" | "completed" | "failed"; message?: string }

async function readJSON(filename: string): Promise<Record<string, unknown> | undefined> {
  return fs.readFile(filename, "utf8").then((content) => JSON.parse(content) as Record<string, unknown>).catch(() => undefined);
}

async function atomicJSON(filename: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.part-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filename);
}

async function readiness(game: { slug: string; dbName: string; gameId: number }): Promise<DeployReadiness> {
  const output = path.join(__dirname, "output", game.slug);
  const resourceAudit = await readJSON(path.join(STATIC_TARGET, game.slug, "resource-audit.json"));
  const dataManifest = await readJSON(path.join(output, "data-manifest.json"));
  const mongoAudit = await readJSON(path.join(output, "mongo-audit-test.json"));
  const validation = await readJSON(path.join(output, "validation-report.json"));
  const sourceHash = await fs.readFile(path.join(output, `${game.slug}.ndjson`)).then(bytes => crypto.createHash("sha256").update(bytes).digest("hex")).catch(() => "");
  const serviceRoot = path.join(process.env.OAKS_SERVICE_SOURCE_ROOT ?? path.resolve(__dirname, "../../../oaksgames"), game.dbName);
  const config = await fs.readFile(path.join(serviceRoot, "config", "config.yaml"), "utf8").catch(() => "");
  return {
    validation: validation?.invalid === 0 && validation?.duplicates === 0 && validation?.sensitiveDocuments === 0 &&
      Array.isArray(validation?.missing) && validation.missing.length === 0 && validation?.targetPerFeature === 10 &&
      Number(validation?.documents) > 0 && validation?.documents === validation?.uniqueRoundHashes &&
      dataManifest?.dataFileSha256 === sourceHash && validation?.documents === dataManifest?.documents,
    service: new RegExp(`^\\s*type:\\s*${game.gameId}\\s*$`, "m").test(config),
    resource: resourceAudit?.complete === true && resourceAudit?.gameId === game.gameId,
    data: dataManifest?.complete === true && dataManifest?.gameId === game.gameId,
    mongo: mongoAudit?.valid === true && mongoAudit?.gameId === game.gameId && mongoAudit?.countsMatch === true && mongoAudit?.contentValid === true && mongoAudit?.uniqueHash === true && mongoAudit?.total === dataManifest?.documents,
  };
}

async function agentRequest<T>(endpoint: string, init?: RequestInit): Promise<T> {
  const baseURL = process.env.OAKS_OPS_AGENT_URL?.replace(/\/$/, "");
  const token = process.env.OAKS_OPS_AGENT_TOKEN;
  if (!baseURL || !token) throw new Error("执行发布必须通过 OAKS_OPS_AGENT_URL 和 OAKS_OPS_AGENT_TOKEN 提供 Ops Agent 连接；Token 不写入文件");
  const response = await fetch(`${baseURL}${endpoint}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json() as AgentResponse<T>;
  if (!response.ok || !body.ok || body.data === undefined) throw new Error(body.message || `Ops Agent 请求失败: ${response.status}`);
  return body.data;
}

async function executeBatch(plan: DeployPlan, batchNumber: number, wait: boolean, reportPath: string): Promise<void> {
  if (!plan.ready) throw new Error(`仍有 ${plan.blockedGames.length} 款未通过 service/resource/data/mongo 门禁，拒绝发布`);
  const batch = plan.batches.find((candidate) => candidate.batch === batchNumber);
  if (!batch) throw new Error(`不存在批次 ${batchNumber}`);
  if (plan.batches.some(item => item.batch < batchNumber && item.status !== "completed")) throw new Error("前序批次未完成，拒绝继续发布");
  if (["running", "failed"].includes(batch.status)) throw new Error("批次已经执行或失败，必须先核实现有 operationId");
  if (batch.status === "completed") throw new Error(`批次 ${batchNumber} 已完成，不重复发布`);
  const system = await agentRequest<{ memory: { available: number }; disk: { available: number } }>("/v1/system");
  const gate = capacityGate(system);
  if (!gate.pass) throw new Error(`测试服容量门禁未通过: ${gate.reasons.join("；")}`);
  const operation = await agentRequest<AgentOperation>("/v1/releases/batch-deploy", {
    method: "POST", body: JSON.stringify(batch.request),
  });
  batch.operationId = operation.id;
  batch.status = operation.status === "pending" || operation.status === "queued" ? "running" : operation.status;
  await atomicJSON(reportPath, { ...plan, updatedAt: new Date().toISOString() });
  if (!wait) return;
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const state = await agentRequest<{ operations: AgentOperation[] }>("/v1/releases");
    const current = state.operations.find((candidate) => candidate.id === operation.id);
    if (!current) throw new Error(`Ops Agent 未返回操作 ${operation.id}`);
    batch.status = current.status === "queued" || current.status === "pending" ? "running" : current.status;
    await atomicJSON(reportPath, { ...plan, updatedAt: new Date().toISOString(), lastMessage: current.message ?? "" });
    if (current.status === "completed") return;
    if (current.status === "failed") throw new Error(`批次 ${batchNumber} 发布失败: ${current.message ?? "未知错误"}`);
  }
  throw new Error(`批次 ${batchNumber} 等待超过 30 分钟，保留 operationId 供续查`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const version = stringOption(args, "--version", `v${new Date().toISOString().replace(/[-:TZ]/g, "").slice(0, 8)}.1`);
  const registryImage = stringOption(args, "--registry-image", "127.0.0.1:5001/api-legacy-release");
  const registry = await readRegistry();
  const active = registry.games.filter((game) => game.active);
  const states = new Map<string, DeployReadiness>();
  // 无实时 Ops Agent 清单时拒绝生成可执行计划，避免重复部署已有服务。
  const services = await agentRequest<Array<{id: string; pid: number; version?: string; status: string}>>("/v1/services");
  for (const game of active) {
    const service = services.find(item => item.id === `game-${game.gameId}`);
    states.set(game.slug, { ...await readiness(game), deployed: !!service && (service.pid > 0 || !!service.version) });
  }
  const root = path.join(__dirname, "output", "deploy", version);
  const reportPath = path.join(root, "deployment-report.json");
  const prior = await fs.readFile(reportPath, "utf8").then((content) => JSON.parse(content) as DeployPlan).catch(() => undefined);
  const plan = mergeDeploymentProgress(buildDeployPlan(active, states, {
    version,
    registryImage,
    batchSize: numberOption(args, "--batch-size", 10),
    operator: stringOption(args, "--operator", "3-oaks-batch-tool"),
    reason: stringOption(args, "--reason", "3 OAKS 全目录分批发布"),
  }), prior);
  await atomicJSON(reportPath, { ...plan, generatedAt: new Date().toISOString() });
  for (const batch of plan.batches) await atomicJSON(path.join(root, `batch-${String(batch.batch).padStart(2, "0")}.json`), batch.request);
  const execute = args.indexOf("--execute-batch");
  if (execute >= 0) {
    const batch = Number(args[execute + 1]);
    if (!Number.isInteger(batch) || batch < 1) throw new Error("--execute-batch 必须指定有效批次号");
    await executeBatch(plan, batch, args.includes("--wait"), reportPath);
  }
  console.log(JSON.stringify({ brand: "3 OAKS", version, total: plan.total, batches: plan.batches.length, ready: plan.ready, blocked: plan.blockedGames.length, reportPath }, null, 2));
  if (!plan.ready) process.exitCode = 2;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
