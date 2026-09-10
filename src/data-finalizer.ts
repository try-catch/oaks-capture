import { featureTarget } from "./capture-checkpoint";

export interface ValidationSummary {
  documents: number;
  invalid: number;
  duplicates: number;
  sensitiveDocuments: number;
  uniqueRoundHashes: number;
  coverage: Record<string, number>;
  examples: Record<string, number[]>;
  required: string[];
}

export interface FinalizeDocument {
  sourceRoundHash: string;
}

export interface MongoAuditSummary {
  total: number;
  valid: boolean;
  featureCounts: Record<string, number>;
}

export function buildDataManifest(
  game: { gameId: number; slug: string; dbName: string },
  documents: FinalizeDocument[],
  validation: ValidationSummary,
  dataFileSha256: string,
  targetPerFeature: number,
  mongoAudit?: MongoAuditSummary,
): Record<string, unknown> {
  if (validation.invalid || validation.duplicates || validation.sensitiveDocuments) {
    throw new Error(`${game.slug} 数据存在 invalid/duplicate/sensitive`);
  }
  if (validation.documents !== documents.length || validation.uniqueRoundHashes !== documents.length) {
    throw new Error(`${game.slug} 文档数与唯一哈希数不一致`);
  }
  if (!/^[a-f0-9]{64}$/.test(dataFileSha256)) throw new Error(`${game.slug} NDJSON SHA-256 非法`);
  const required = [...new Set(validation.required)].sort();
  const featureHashes: Record<string, string[]> = {};
  for (const feature of required) {
    const target = featureTarget(feature, targetPerFeature);
    if ((validation.coverage[feature] ?? 0) < target) throw new Error(`${game.slug} 分支 ${feature} 少于 ${target} 条`);
    const hashes = [...new Set((validation.examples[feature] ?? []).map((line) => documents[line - 1]?.sourceRoundHash).filter(Boolean))];
    if (hashes.length < target || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
      throw new Error(`${game.slug} 分支 ${feature} 缺少 ${target} 个有效内容哈希`);
    }
    featureHashes[feature] = hashes.slice(0, target);
  }
  if (mongoAudit && (!mongoAudit.valid || mongoAudit.total !== documents.length)) {
    throw new Error(`${game.slug} MongoDB 回读未通过`);
  }
  return {
    brand: "3 OAKS",
    gameId: game.gameId,
    slug: game.slug,
    dbName: game.dbName,
    documents: documents.length,
    targetPerFeature,
    required,
    counts: Object.fromEntries(required.map((feature) => [feature, validation.coverage[feature] ?? 0])),
    featureHashes,
    dataFileSha256,
    mongoReadCount: mongoAudit?.total ?? null,
    complete: true,
  };
}
