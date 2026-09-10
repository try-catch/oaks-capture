import fs from "node:fs/promises";
import path from "node:path";
import { readRegistry } from "./catalog-sync";
import { selectGames } from "./src/cli";
import { sanitizeProtocolData, sourceRoundHash } from "./src/mongo-store";

type CapturedDocument = Record<string, unknown> & { data: unknown };

export function sanitizeCapturedDocument(document: CapturedDocument): CapturedDocument {
  const sanitized = sanitizeProtocolData(document) as CapturedDocument;
  sanitized.sourceRoundHash = sourceRoundHash(sanitized);
  return sanitized;
}

async function sanitizeFile(filename: string): Promise<{ documents: number; changed: number }> {
  const original = await fs.readFile(filename, "utf8");
  const lines = original.split(/\r?\n/).filter(Boolean);
  let changed = 0;
  const sanitized = lines.map((line) => {
    const before = JSON.parse(line) as CapturedDocument;
    const after = sanitizeCapturedDocument(before);
    const result = JSON.stringify(after);
    if (result !== line) changed++;
    return result;
  });
  if (changed > 0) {
    const temporary = `${filename}.part-${process.pid}`;
    await fs.writeFile(temporary, `${sanitized.join("\n")}\n`);
    await fs.rename(temporary, filename);
  }
  return { documents: lines.length, changed };
}

async function main(): Promise<void> {
  const games = selectGames(process.argv.slice(2), await readRegistry());
  for (const game of games) {
    const filename = path.join(__dirname, "output", game.slug, `${game.slug}.ndjson`);
    const result = await sanitizeFile(filename);
    console.log(`[sanitize ${game.slug}] documents=${result.documents} changed=${result.changed}`);
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
