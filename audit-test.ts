import fs from "node:fs/promises";
import path from "node:path";
import { readRegistry } from "./catalog-sync";
import { auditServices, auditTestList, TestListGame, TestService } from "./src/test-audit";

interface APIResponse<T> { ok: boolean; data?: T; message?: string }

async function atomicJSON(filename: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.part-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filename);
}

async function agentRequest<T>(endpoint: string): Promise<T> {
  const baseURL = process.env.OAKS_OPS_AGENT_URL?.replace(/\/$/, "");
  const token = process.env.OAKS_OPS_AGENT_TOKEN;
  if (!baseURL || !token) throw new Error("Ops Agent 验收需要 OAKS_OPS_AGENT_URL 和 OAKS_OPS_AGENT_TOKEN；Token 不会写入报告");
  const response = await fetch(`${baseURL}${endpoint}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json() as APIResponse<T>;
  if (!response.ok || !body.ok || body.data === undefined) throw new Error(body.message || `Ops Agent 请求失败: ${response.status}`);
  return body.data;
}

async function main(): Promise<void> {
  const registry = await readRegistry();
  const active = registry.games.filter((game) => game.active);
  const endpoint = process.env.OAKS_TEST_LIST_URL ?? "https://demo-game.vg778.com/test/v1/get-game-list";
  const listResponse = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!listResponse.ok) throw new Error(`测试站游戏列表请求失败: ${listResponse.status}`);
  const listBody = await listResponse.json() as { games?: TestListGame[] };
  const gameList = auditTestList(active, listBody.games ?? []);

  let services: Record<string, unknown> = { valid: false, skipped: true, reason: "未提供 Ops Agent 连接" };
  if (process.env.OAKS_OPS_AGENT_URL || process.env.OAKS_OPS_AGENT_TOKEN) {
    const [system, liveServices] = await Promise.all([
      agentRequest<{ memory: { available: number }; disk: { available: number } }>("/v1/system"),
      agentRequest<TestService[]>("/v1/services"),
    ]);
    services = auditServices(active, liveServices, system);
  }

  const mongoMissing: string[] = [];
  const dataMissing: string[] = [];
  const resourceMissing: string[] = [];
  const e2eMissing: string[] = [];
  for (const game of active) {
    const output = path.join(__dirname, "output", game.slug);
    const mongo = await fs.readFile(path.join(output, "mongo-audit-test.json"), "utf8").then((value) => JSON.parse(value)).catch(() => undefined);
    const data = await fs.readFile(path.join(output, "data-manifest.json"), "utf8").then((value) => JSON.parse(value)).catch(() => undefined);
    const resource = await fs.readFile(path.resolve(__dirname, "../../../../api_new_docker/api_new/client/game/oaks/static", game.slug, "resource-audit.json"), "utf8").then((value) => JSON.parse(value)).catch(() => undefined);
    const e2e = await fs.readFile(path.join(output, "test-e2e-report.json"), "utf8").then((value) => JSON.parse(value)).catch(() => undefined);
    if (mongo?.valid !== true) mongoMissing.push(game.slug);
    if (data?.complete !== true) dataMissing.push(game.slug);
    if (resource?.complete !== true) resourceMissing.push(game.slug);
    if (e2e?.complete !== true || e2e?.desktop !== true || e2e?.mobile !== true || e2e?.spinSettlement !== true ||
      e2e?.locales !== true || e2e?.remoteResourceHashes !== true || e2e?.externalOfficialRequests !== 0) e2eMissing.push(game.slug);
  }
  const data = { mongoMissing, dataMissing, valid: mongoMissing.length === 0 && dataMissing.length === 0 };
  const resources = { missing: resourceMissing, valid: resourceMissing.length === 0 };
  const endToEnd = { missing: e2eMissing, valid: e2eMissing.length === 0 };
  const complete = gameList.valid === true && services.valid === true && data.valid && resources.valid && endToEnd.valid;
  const report = {
    brand: "3 OAKS", generatedAt: new Date().toISOString(), total: active.length, complete,
    gameList, services, data, resources, endToEnd,
  };
  const output = path.join(__dirname, "output", "final-test-report.json");
  await atomicJSON(output, report);
  console.log(JSON.stringify({ brand: "3 OAKS", total: active.length, complete, gameListValid: gameList.valid, serviceValid: services.valid, mongoMissing: mongoMissing.length, dataMissing: dataMissing.length, resourceMissing: resourceMissing.length, e2eMissing: e2eMissing.length, output }, null, 2));
  if (!complete) process.exitCode = 2;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
