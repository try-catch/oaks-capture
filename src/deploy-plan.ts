import { RegistryGame } from "./catalog";

export const MAX_BATCH_SIZE = 10;
export const MIN_AVAILABLE_MEMORY = 8 * 1024 ** 3;
export const MIN_AVAILABLE_DISK = 80 * 1024 ** 3;

export interface OpsSystemInfo {
  memory: { available: number };
  disk: { available: number };
}

export interface DeployReadiness {
  service: boolean;
  resource: boolean;
  data: boolean;
  mongo: boolean;
  validation: boolean;
  deployed?: boolean;
}

export interface DeployBatch {
  batch: number;
  status: "blocked" | "pending" | "running" | "completed" | "failed";
  operationId: string | null;
  games: Array<{ gameId: number; slug: string; serviceId: string; image: string }>;
  request: {
    scope: "platform";
    platform: "OAKS";
    version: string;
    operator: string;
    reason: string;
    items: Array<{ serviceId: string; image: string }>;
  };
}

export interface DeployPlan {
  brand: "3 OAKS";
  version: string;
  registryImage: string;
  architecture: "amd64";
  batchSize: number;
  total: number;
  ready: boolean;
  blockedGames: Array<{ gameId: number; slug: string; missing: string[] }>;
  batches: DeployBatch[];
}

function validateVersion(version: string): void {
  if (!/^v\d{8}\.(?:\d{6}|[1-9]\d*)$/.test(version)) {
    throw new Error(`版本号格式不正确: ${version}`);
  }
}

function validateRegistryImage(registryImage: string): void {
  if (!/^[a-zA-Z0-9._:/-]+$/.test(registryImage) || registryImage.includes("..")) {
    throw new Error(`Registry 镜像前缀不安全: ${registryImage}`);
  }
}

export function capacityGate(system: OpsSystemInfo): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!Number.isFinite(system.memory.available) || system.memory.available < MIN_AVAILABLE_MEMORY) {
    reasons.push(`可用内存低于 ${MIN_AVAILABLE_MEMORY} 字节`);
  }
  if (!Number.isFinite(system.disk.available) || system.disk.available < MIN_AVAILABLE_DISK) {
    reasons.push(`可用磁盘低于 ${MIN_AVAILABLE_DISK} 字节`);
  }
  return { pass: reasons.length === 0, reasons };
}

export function buildDeployPlan(
  games: RegistryGame[],
  readiness: Map<string, DeployReadiness>,
  options: { version: string; registryImage: string; batchSize?: number; operator?: string; reason?: string },
): DeployPlan {
  validateVersion(options.version);
  validateRegistryImage(options.registryImage);
  const batchSize = options.batchSize ?? MAX_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`批次大小必须在 1 到 ${MAX_BATCH_SIZE} 之间`);
  }
  const active = games.filter((game) => game.active).sort((left, right) => left.gameId - right.gameId);
  const ids = new Set<number>();
  const slugs = new Set<string>();
  for (const game of active) {
    if (ids.has(game.gameId) || slugs.has(game.slug)) throw new Error(`注册表存在重复游戏: ${game.gameId}/${game.slug}`);
    ids.add(game.gameId);
    slugs.add(game.slug);
  }
  const blockedGames = active.flatMap((game) => {
    const state = readiness.get(game.slug);
    const missing = (["service", "resource", "data", "mongo", "validation"] as const).filter((key) => state?.[key] !== true);
    return missing.length ? [{ gameId: game.gameId, slug: game.slug, missing: [...missing] }] : [];
  });
  const blocked = new Set(blockedGames.map((game) => game.slug));
  const eligible = active.filter((game) => !blocked.has(game.slug) && readiness.get(game.slug)?.deployed !== true);
  const batches: DeployBatch[] = [];
  for (let offset = 0; offset < eligible.length; offset += batchSize) {
    const batchGames = eligible.slice(offset, offset + batchSize).map((game) => {
      const serviceId = `game-${game.gameId}`;
      return {
        gameId: game.gameId,
        slug: game.slug,
        serviceId,
        image: `${options.registryImage}:${options.version}-${serviceId}-amd64`,
      };
    });
    batches.push({
      batch: batches.length + 1,
      status: "pending",
      operationId: null,
      games: batchGames,
      request: {
        scope: "platform",
        platform: "OAKS",
        version: options.version,
        operator: options.operator ?? "3-oaks-batch-tool",
        reason: options.reason ?? "3 OAKS 全目录分批发布",
        items: batchGames.map(({ serviceId, image }) => ({ serviceId, image })),
      },
    });
  }
  return {
    brand: "3 OAKS", version: options.version, registryImage: options.registryImage,
    architecture: "amd64", batchSize, total: active.length, ready: eligible.length > 0, blockedGames, batches,
  };
}

export function mergeDeploymentProgress(plan: DeployPlan, prior?: DeployPlan): DeployPlan {
  if (!prior || prior.version !== plan.version || prior.registryImage !== plan.registryImage) return plan;
  const priorByBatch = new Map(prior.batches.map((batch) => [batch.batch, batch]));
  return {
    ...plan,
    batches: plan.batches.map((batch) => {
      const old = priorByBatch.get(batch.batch);
      const sameTargets = old && old.games.map((game) => game.serviceId).join(",") === batch.games.map((game) => game.serviceId).join(",");
      if (!sameTargets || old.status === "blocked" || batch.status === "blocked") return batch;
      return { ...batch, status: old.status, operationId: old.operationId };
    }),
  };
}
