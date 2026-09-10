import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validateRound } from "./src/protocol";

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1]) : fallback;
}

async function main(): Promise<void> {
  const source = path.resolve(__dirname, option("--from", "output/sun_of_egypt.ndjson"));
  const target = path.resolve(__dirname, "seed-data/sun_of_egypt.ndjson");
  const wanted = option("--features", "free-retrigger,hold-win-during-free-spins,mini-jackpot,major-jackpot,grand-full-board")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const targetLines = (await fs.readFile(target, "utf8")).split(/\r?\n/).filter(Boolean);
  const sourceLines = (await fs.readFile(source, "utf8")).split(/\r?\n/).filter(Boolean);
  const known = new Set(targetLines.map((line) => crypto.createHash("sha256").update(JSON.stringify(JSON.parse(line).data)).digest("hex")));
  const covered = new Set<string>();
  const additions: string[] = [];

  for (const line of sourceLines) {
    const document = JSON.parse(line);
    const validation = validateRound(document.data, Number(document.bet));
    const matches = wanted.filter((feature) => validation.features.includes(feature) && !covered.has(feature));
    if (matches.length === 0) continue;
    const hash = crypto.createHash("sha256").update(JSON.stringify(document.data)).digest("hex");
    if (!known.has(hash)) {
      additions.push(JSON.stringify({
        ...document,
        mul: validation.win / Number(document.bet),
        branches: validation.features,
        features: validation.features,
        captureVersion: 2,
        settlementField: "context.current.total_win",
        validation: { valid: true, cumulativeWins: validation.cumulativeWins },
        rtp: [],
        testOnly: true,
      }));
      known.add(hash);
    }
    matches.forEach((feature) => covered.add(feature));
    if (wanted.every((feature) => covered.has(feature))) break;
  }

  if (additions.length > 0) await fs.writeFile(target, `${[...targetLines, ...additions].join("\n")}\n`);
  console.log(JSON.stringify({ source, added: additions.length, covered: [...covered].sort(), missing: wanted.filter((feature) => !covered.has(feature)) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
