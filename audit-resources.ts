import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readRegistry } from "./catalog-sync";
import { STATIC_TARGET } from "./config";
import type { RegistryGame } from "./src/catalog";
import { selectGames } from "./src/cli";
import type { NetworkMatrixReport } from "./src/network-matrix";
import { DEVICE_PROFILES } from "./src/network-matrix";
import { computeResourceStatus } from "./src/resource-status";
import type { DownloadReport } from "./src/static-downloader";

interface AuditedFile {
  url: string;
  localPath: string;
  size: number;
  sha256: string;
  emptyAllowed?: boolean;
}

async function readJSON<T>(filename: string): Promise<T> {
  return JSON.parse(await fs.readFile(filename, "utf8")) as T;
}

async function atomicJSON(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.part-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filename);
}

/** 磁盘文件名是解码后的形态，与静态服务的 URI 解码行为保持一致。 */
function diskPath(url: string): string {
  const pathname = new URL(url).pathname
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
  return path.join(STATIC_TARGET, pathname.replace(/^\/+/, ""));
}

function hash(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export async function auditGameResources(game: RegistryGame): Promise<Record<string, unknown>> {
  if (!game.discovery) throw new Error(`${game.slug} 缺少能力清单`);
  const gameRoot = path.join(STATIC_TARGET, game.slug);
  const downloadPath = path.join(gameRoot, "download-report.json");
  const matrixPath = path.join(gameRoot, "network-matrix.json");
  const [download, matrix] = await Promise.all([
    readJSON<DownloadReport>(downloadPath),
    readJSON<NetworkMatrixReport & { mirror?: { downloaded: number; failed: unknown[] } }>(matrixPath),
  ]);
  const expectedLocales = [...game.discovery.locales].sort();
  const observedLocales = new Set(matrix.runs.filter((run) => run.staticRequests > 0 && run.failedRequests === 0).map((run) => run.locale));
  const observedProfiles = new Set(matrix.runs.filter((run) => run.staticRequests > 0 && run.failedRequests === 0).map((run) => run.profile));
  const missingLocales = expectedLocales.filter((locale) => !observedLocales.has(locale));
  const missingProfiles = Object.keys(DEVICE_PROFILES).filter((profile) => !observedProfiles.has(profile as keyof typeof DEVICE_PROFILES));
  const expected = new Map<string, { sha256?: string; emptyAllowed?: boolean }>();
  for (const file of download.files ?? []) expected.set(file.url, { sha256: file.sha256, emptyAllowed: file.emptyAllowed });
  for (const file of matrix.resources ?? []) if (!expected.has(file.url)) expected.set(file.url, {});
  const files: AuditedFile[] = [];
  const missingFiles: string[] = [];
  const emptyFiles: string[] = [];
  const hashMismatches: string[] = [];
  for (const [url, expectation] of [...expected.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const localPath = diskPath(url);
    const bytes = await fs.readFile(localPath).catch(() => undefined);
    if (!bytes) {
      missingFiles.push(url);
      continue;
    }
    if (!bytes.length && !expectation.emptyAllowed) emptyFiles.push(url);
    const actualHash = hash(bytes);
    if (expectation.sha256 && expectation.sha256 !== actualHash) hashMismatches.push(url);
    files.push({ url, localPath, size: bytes.length, sha256: actualHash, ...(expectation.emptyAllowed ? { emptyAllowed: true } : {}) });
  }
  const closureFailed = (download.failed?.length ?? 0) + (matrix.mirror?.failed?.length ?? 0);
  const status = computeResourceStatus({
    closureFailed,
    networkFailed: matrix.failed?.length ?? 0,
    missingLocales,
    missingProfiles,
    missingFiles,
    hashMismatches,
    emptyFiles,
  });
  const audit = {
    brand: "3 OAKS",
    gameId: game.gameId,
    slug: game.slug,
    generatedAt: new Date().toISOString(),
    expectedLocales,
    observedLocales: [...observedLocales].sort(),
    observedProfiles: [...observedProfiles].sort(),
    files,
    ...status,
  };
  await atomicJSON(path.join(gameRoot, "resource-audit.json"), audit);
  return audit;
}

async function main(): Promise<void> {
  const selected = selectGames(process.argv.slice(2), await readRegistry());
  const failed: Array<{ slug: string; error: string }> = [];
  for (const [index, game] of selected.entries()) {
    try {
      const report = await auditGameResources(game);
      console.log(`[resource-audit ${index + 1}/${selected.length}] ${game.slug} complete=${String(report.complete)} files=${(report.files as unknown[]).length}`);
      if (!report.complete) failed.push({ slug: game.slug, error: "资源门禁未通过" });
    } catch (error) {
      failed.push({ slug: game.slug, error: (error as Error).message });
      console.warn(`[resource-audit failed] ${game.slug}: ${(error as Error).message}`);
    }
  }
  console.log(JSON.stringify({ brand: "3 OAKS", completed: selected.length - failed.length, failed }, null, 2));
  if (failed.length) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
