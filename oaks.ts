import { finalizeTestCapture } from "./src/test-finalization";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { captureRuntime } from "./src/capture-runtime";
import { MongoClient } from "mongodb";
import { readRegistry } from "./catalog-sync";
import { FALLBACK_SPIN_DELAY_MS, MONGO_COLLECTION, MONGO_URI, RTP_BUCKETS, SPIN_DELAY_MS } from "./config";
import type { RegistryGame } from "./src/catalog";
import { coverageComplete, remainingTargets, writeCheckpoint } from "./src/capture-checkpoint";
import { CaptureThrottle } from "./src/capture-throttle";
import { numberOption, selectGames, stringOption } from "./src/cli";
import { classifyRound, discoverFeatureInventory, FeatureInventory } from "./src/features";
import { discoverGame } from "./src/game-definition";
import { ensureMongoIndexes, sanitizeProtocolData, sourceRoundHash, upsertMongoRound } from "./src/mongo-store";
import { actionFeatureKey, actionSpinType, command, JSONMap, nextAction, openSession, protocolAction, ProtocolHttpError, roundSpinType, Session } from "./src/protocol";
import { buildPlayableActions, discoverShop, PlayAction, ShopInventory } from "./src/shop";
import { validateGameRound } from "./src/validators";

const args = process.argv.slice(2);
const targetPerFeature = numberOption(args, "--target-per-feature", 10);
const maxNewRounds = numberOption(args, "--rounds", 1_000_000);
const maxRetries = numberOption(args, "--max-retries", 5);
const explicitRequired = stringOption(args, "--require", "").split(",").map((value) => value.trim()).filter(Boolean);

interface CapturedDocument extends Record<string, unknown> {
  gameId: number;
  game: string;
  data: JSONMap[];
  features: string[];
  sourceRoundHash: string;
}

export function retryDelayMs(error: unknown, attempt: number): number {
  const rateLimited = error instanceof ProtocolHttpError && error.status === 429;
  const exponential = Math.min(60_000, 2_000 * (2 ** Math.max(0, attempt - 1)));
  return Math.max(rateLimited ? 10_000 : 1_000, exponential, rateLimited ? error.retryAfterMs : 0);
}

async function waitForRetry(delayMs: number, game: RegistryGame): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < delayMs) {
    const remaining = delayMs - (Date.now() - startedAt);
    await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, remaining)));
    const left = delayMs - (Date.now() - startedAt);
    if (left > 0) console.log(`[session ${game.slug}] 官方限流等待中，剩余约 ${Math.ceil(left / 1000)} 秒`);
  }
}

async function openSessionWithRetry(
  game: RegistryGame,
  definition: NonNullable<RegistryGame["discovery"]>,
  throttle: CaptureThrottle,
): Promise<Session> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await openSession(definition);
    } catch (error) {
      lastError = error;
      if (captureRuntime) throw error;
      if (attempt > maxRetries) break;
      const delay = Math.max(retryDelayMs(error, attempt), throttle.recordRateLimit(error, game.slug));
      console.warn(`[session ${game.slug} ${attempt}/${maxRetries}] ${(error as Error).message}，等待 ${Math.ceil(delay / 1000)} 秒后重试`);
      await waitForRetry(delay, game);
    }
  }
  throw lastError;
}

async function readDocuments(filename: string): Promise<CapturedDocument[]> {
  const content = await fs.readFile(filename, "utf8").catch(() => "");
  const documents: CapturedDocument[] = [];
  for (const [index, line] of content.split(/\r?\n/).filter(Boolean).entries()) {
    try {
      const document = JSON.parse(line) as CapturedDocument;
      document.sourceRoundHash = String(document.sourceRoundHash ?? sourceRoundHash(document));
      documents.push(document);
    } catch (error) {
      throw new Error(`${filename} 第 ${index + 1} 行无法恢复: ${(error as Error).message}`);
    }
  }
  return documents;
}

function countCoverage(documents: CapturedDocument[]): { counts: Record<string, number>; hashes: Set<string> } {
  const counts: Record<string, number> = {};
  const hashes = new Set<string>();
  for (const document of documents) {
    if (hashes.has(document.sourceRoundHash)) continue;
    hashes.add(document.sourceRoundHash);
    const spinType = roundSpinType(document.data, Number(document.buy ?? 0));
    for (const feature of new Set(document.features ?? [])) {
      if (spinType !== 0 && ["base-loss", "base-or-feature-win"].includes(feature)) continue;
      counts[feature] = (counts[feature] ?? 0) + 1;
    }
  }
  return { counts, hashes };
}

type ActionEvidence = Record<string, Set<string>>;

function actionKeyFromDocument(document: CapturedDocument): string {
  const context = document.data[0]?.context ?? {};
  const name = String(context.last_action ?? "");
  const selectedMode = Number(context.last_args?.selected_mode);
  if (name === "buy_spin" && Number.isInteger(selectedMode) && selectedMode >= 0) return `buy-bonus:${selectedMode}`;
  if (name === "spin" && context.last_args?.ante_bet && Number.isInteger(selectedMode) && selectedMode > 0) return `booster:${selectedMode}`;
  return "spin";
}

function collectActionEvidence(documents: CapturedDocument[]): ActionEvidence {
  const evidence: ActionEvidence = {};
  for (const document of documents) {
    const key = actionKeyFromDocument(document);
    const features = (evidence[key] ??= new Set<string>());
    for (const feature of document.features ?? []) features.add(feature);
  }
  return evidence;
}

async function loadInventory(game: RegistryGame, session: Session, outputDir: string): Promise<FeatureInventory> {
  const filename = path.join(outputDir, "feature-inventory.json");
  const saved = await fs.readFile(filename, "utf8").then((content) => JSON.parse(content) as FeatureInventory).catch(() => undefined);
  if (!game.discovery) throw new Error(`${game.slug} 缺少能力发现结果`);
  const inventory = discoverFeatureInventory(game.discovery, session.start);
  if (saved?.schemaVersion === inventory.schemaVersion && saved.buyModesFingerprint === inventory.buyModesFingerprint) return saved;
  await fs.writeFile(filename, `${JSON.stringify({ brand: "3 OAKS", gameId: game.gameId, slug: game.slug, generatedAt: new Date().toISOString(), ...inventory }, null, 2)}\n`);
  return inventory;
}

export function targetFeature(action: PlayAction): string | undefined {
  const feature = actionFeatureKey(action);
  return feature === "spin" ? undefined : feature;
}

export function chooseAction(
  actions: PlayAction[],
  counts: Record<string, number>,
  target: number,
  required: string[],
  actionEvidence: ActionEvidence = {},
  sequence = 0,
): PlayAction {
  const requiredSet = new Set(required);
  const baseAction = actions.find((action) => action.name === "spin" && !action.params.ante_bet) ?? actions[0];
  const missingBase = ["base-loss", "base-or-feature-win"].some((feature) =>
    requiredSet.has(feature) && (counts[feature] ?? 0) < 1);
  if (missingBase) return baseAction;
  const directed = actions.find((action) => {
    const feature = targetFeature(action);
    return feature && requiredSet.has(feature) && (counts[feature] ?? 0) < target;
  });
  if (directed) return directed;
  const missingSpecial = required.filter((feature) =>
    !["base-loss", "base-or-feature-win"].includes(feature) && (counts[feature] ?? 0) < target);
  const specialActions = actions.filter((action) => Boolean(targetFeature(action)));
  if (missingSpecial.length && specialActions.length) {
    const ranked = specialActions.map((action, index) => {
      const key = targetFeature(action)!;
      const observed = actionEvidence[key] ?? new Set<string>();
      return { action, index, score: missingSpecial.filter((feature) => observed.has(feature)).length };
    }).sort((left, right) => right.score - left.score || left.index - right.index);
    if (ranked[0].score > 0) return ranked[0].action;
    const exploration = [baseAction, ...specialActions];
    return exploration[Math.abs(sequence) % exploration.length];
  }
  return baseAction;
}

export async function playRound(session: Session, action: PlayAction): Promise<JSONMap[]> {
  const pending = captureRuntime?.pending() ?? { id: crypto.randomUUID(), session, action, frames: [] };
  session = pending.session;
  action = pending.action;
  const frames: JSONMap[] = pending.frames;
  captureRuntime?.savePending(pending);
  captureRuntime?.requestStep(pending.id, frames.length);
  let response = frames.at(-1) ?? await command(session.endpoint, session.cookie, "play", {
    session_id: session.sessionId,
    action: protocolAction(action),
    bet: session.defaultBet,
  });
  if (!frames.length) { frames.push(response); captureRuntime?.savePending(pending); }
  for (let step = 0; step < 100; step++) {
    const name = nextAction(response);
    if (!name) return frames;
    captureRuntime?.requestStep(pending.id, frames.length);
    response = await command(session.endpoint, session.cookie, "play", {
      session_id: session.sessionId,
      action: { name, params: {} },
    });
    frames.push(response);
    captureRuntime?.savePending(pending);
  }
  throw new Error("特殊局超过 100 帧，已中止防止死循环");
}

function actionCostMultiplier(action: PlayAction, shop: ShopInventory): number {
  const feature = targetFeature(action);
  if (!feature) return 1;
  const entries = feature.startsWith("booster:") ? shop.boosters : shop.buyBonuses;
  return entries.find((entry) => entry.feature === feature)?.price ?? 1;
}

export async function captureGame(
  game: RegistryGame,
  throttle = new CaptureThrottle({ spinDelayMs: SPIN_DELAY_MS, fallbackSpinDelayMs: FALLBACK_SPIN_DELAY_MS }),
): Promise<void> {
  if (captureRuntime && !game.discovery) throw new Error("Actions 采集缺少已核实的官方能力定义");
  const definition = game.discovery ?? await discoverGame(game.slug);
  const outputDir = path.resolve(__dirname, "output", game.slug);
  await fs.mkdir(outputDir, { recursive: true });
  const outputName = stringOption(args, "--output", `${game.slug}.ndjson`);
  const ndjson = path.resolve(outputDir, outputName);
  const outputBase = path.basename(outputName, path.extname(outputName));
  const isDefaultOutput = outputName === `${game.slug}.ndjson`;
  await fs.appendFile(ndjson, "");
  const priorDocuments = await readDocuments(ndjson);
  const { counts, hashes } = countCoverage(priorDocuments);
  const actionEvidence = collectActionEvidence(priorDocuments);

  let mongo: MongoClient | undefined;
  let collection: any;
  const database = process.env.OAKS_MONGO_DB ?? game.dbName;
  try {
    mongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 2500 });
    await mongo.connect();
    collection = mongo.db(database).collection(MONGO_COLLECTION);
    await ensureMongoIndexes(collection);
    for (const document of priorDocuments) await upsertMongoRound(collection, document);
    console.log(`[Mongo] 已连接并去重同步 ${database}.${MONGO_COLLECTION}`);
  } catch (error) {
    if (captureRuntime) throw new Error("测试服 Mongo 连接或去重同步失败，禁止发出官方请求");
    console.warn(`[Mongo] 未连接，本次仅保存 NDJSON：${(error as Error).message}`);
    await mongo?.close().catch(() => undefined);
    mongo = undefined;
    collection = undefined;
  }

  try {
  let session = captureRuntime?.pending()?.session ?? await openSessionWithRetry(game, definition, throttle);
  await fs.writeFile(path.join(outputDir, "start-template.json"), `${JSON.stringify(sanitizeProtocolData(session.start), null, 2)}\n`);
  const inventory = await loadInventory(game, session, outputDir);
  captureRuntime?.syncFiles();
  const required = [...new Set(["base-loss", "base-or-feature-win", ...(explicitRequired.length ? explicitRequired : inventory.required)])].sort();
  const checkpointPath = path.join(outputDir, isDefaultOutput ? "capture-checkpoint.json" : `${outputBase}-checkpoint.json`);
  let captured = priorDocuments.length;
  let newCaptured = 0;
  let retries = 0;
  let lastCompletedHash = priorDocuments.at(-1)?.sourceRoundHash;
  let attempted = 0;

  while ((captureRuntime?.pending() || !coverageComplete(required, counts, targetPerFeature)) && attempted < maxNewRounds) {
    if (captureRuntime?.shouldStop()) throw new Error("ACTIONS_BUDGET");
    try {
      const shop = discoverShop(session.start);
      const actions = buildPlayableActions(session.start, shop);
      if (!actions.length) throw new Error("start 没有可执行动作");
      const action = captureRuntime?.pending()?.action ?? chooseAction(actions, counts, targetPerFeature, required, actionEvidence, captured);
      const rawFrames = await playRound(session, action);
      attempted++;
      const frames = sanitizeProtocolData(rawFrames) as JSONMap[];
      const validation = validateGameRound(game, frames, session.defaultBet);
      const features = new Set(validation.features);
      for (const evidence of classifyRound(frames)) features.add(evidence.name);
      const directed = targetFeature(action);
      if (directed) features.add(directed);
      const document: CapturedDocument = {
        gameId: game.gameId,
        game: game.slug,
        data: frames,
        bonus: frames.length > 1 ? 1 : 0,
        mul: validation.win / session.defaultBet,
        bet: session.defaultBet,
        buy: actionSpinType(action),
        actionName: action.name,
        selectedMode: Number(action.params.selected_mode ?? 0),
        costMultiplier: actionCostMultiplier(action, shop),
        rtp: [...RTP_BUCKETS],
        branches: [...features].sort(),
        features: [...features].sort(),
        captureVersion: 4,
        settlementField: "context.current.total_win",
        validation: { valid: true, cumulativeWins: validation.cumulativeWins },
        capturedAt: new Date(),
        source: definition.playUrl,
        sourceRoundHash: "",
      };
      document.sourceRoundHash = sourceRoundHash(document);
      if (!hashes.has(document.sourceRoundHash)) {
        captureRuntime?.writeDocument(document);
        await fs.appendFile(ndjson, `${JSON.stringify(document)}\n`);
        if (collection) await upsertMongoRound(collection, document);
        hashes.add(document.sourceRoundHash);
        lastCompletedHash = document.sourceRoundHash;
        for (const feature of features) {
          if (Number(document.buy) !== 0 && ["base-loss", "base-or-feature-win"].includes(feature)) continue;
          counts[feature] = (counts[feature] ?? 0) + 1;
        }
        const actionFeatures = (actionEvidence[targetFeature(action) ?? "spin"] ??= new Set<string>());
        for (const feature of features) actionFeatures.add(feature);
        captured++;
        newCaptured++;
      }
      // 包括崩溃后已从 NDJSON 同步到 Mongo 的同一局，只有双写成功才清除未完成局。
      captureRuntime?.acknowledge(document);
      retries = 0;
      const checkpointDue = captured % 10 === 0 || frames.length > 1;
      if (checkpointDue) await writeCheckpoint(checkpointPath, {
        brand: "3 OAKS",
        slug: game.slug,
        targetPerFeature,
        counts,
        completedHashCount: hashes.size,
        lastCompletedHash,
        captured,
        updatedAt: new Date().toISOString(),
      });
      if (checkpointDue) {
        console.log(`[${game.slug}] captured=${captured} new=${newCaptured} frames=${frames.length} remaining=${JSON.stringify(remainingTargets(counts, required, targetPerFeature))}`);
      }
      if (throttle.spinDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, throttle.spinDelayMs));
    } catch (error) {
      if (captureRuntime) throw error;
      retries++;
      if (retries > maxRetries) throw new Error(`${game.slug} 连续失败 ${retries} 次: ${(error as Error).message}`);
      const rateLimitDelay = throttle.recordRateLimit(error, game.slug);
      console.warn(`[retry ${game.slug} ${retries}/${maxRetries}] ${(error as Error).message}`);
      if (rateLimitDelay > 0) {
        console.warn(`[rate-limit ${game.slug}] 暂停整个顺序采集队列 ${Math.ceil(rateLimitDelay / 1000)} 秒`);
        await waitForRetry(rateLimitDelay, game);
      }
      session = await openSessionWithRetry(game, definition, throttle);
    }
  }

  const complete = coverageComplete(required, counts, targetPerFeature);
  await writeCheckpoint(checkpointPath, {
    brand: "3 OAKS",
    slug: game.slug,
    targetPerFeature,
    counts,
    completedHashCount: hashes.size,
    lastCompletedHash,
    captured,
    updatedAt: new Date().toISOString(),
  });
  const report = {
    brand: "3 OAKS",
    game: game.slug,
    captured,
    newCaptured,
    targetPerFeature,
    required,
    counts,
    remaining: remainingTargets(counts, required, targetPerFeature),
    spinDelayMs: throttle.spinDelayMs,
    rateLimitEvents: throttle.events,
    complete,
  };
  await fs.writeFile(path.join(outputDir, isDefaultOutput ? "coverage.json" : `${outputBase}-coverage.json`), `${JSON.stringify(report, null, 2)}\n`);
  if (!complete) throw new Error(`${game.slug} 达到本轮上限 ${maxNewRounds}，特殊分支覆盖尚未完成`);
  console.log(`3 OAKS ${game.slug} 采集完成：${captured} 局，全部分支 >= ${targetPerFeature}`);
  } finally {
    await mongo?.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const games = selectGames(args, await readRegistry());
  const throttle = new CaptureThrottle({ spinDelayMs: SPIN_DELAY_MS, fallbackSpinDelayMs: FALLBACK_SPIN_DELAY_MS });
  for (const game of games) {
    await captureGame(game, throttle);
    // 显式 Mongo 环境的采集完成后立即生成严格的测试服验收证据。
    if (process.env.OAKS_TEST_MONGO_URI || process.env.OAKS_MONGO_URI) finalizeTestCapture(game.slug);
  }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
