import fs from "node:fs/promises";
import path from "node:path";

export interface CaptureCheckpoint {
  brand: "3 OAKS";
  slug: string;
  targetPerFeature: number;
  counts: Record<string, number>;
  completedHashCount: number;
  lastCompletedHash?: string;
  completedHashes?: string[];
  captured: number;
  updatedAt: string;
}

export function featureTarget(feature: string, specialTarget = 10): number {
  return ["base-loss", "base-or-feature-win"].includes(feature) ? 1 : specialTarget;
}

export function remainingTargets(counts: Record<string, number>, required: string[], target = 10): Record<string, number> {
  return Object.fromEntries(required
    .filter((feature) => (counts[feature] ?? 0) < featureTarget(feature, target))
    .map((feature) => [feature, featureTarget(feature, target) - (counts[feature] ?? 0)]));
}

export function coverageComplete(required: string[], counts: Record<string, number>, target = 10): boolean {
  return required.every((feature) => (counts[feature] ?? 0) >= featureTarget(feature, target));
}

export async function readCheckpoint(filename: string): Promise<CaptureCheckpoint | undefined> {
  return fs.readFile(filename, "utf8").then((content) => JSON.parse(content) as CaptureCheckpoint).catch(() => undefined);
}

export async function writeCheckpoint(filename: string, checkpoint: CaptureCheckpoint): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.part-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`);
  await fs.rename(temporary, filename);
}
