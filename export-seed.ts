import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validateRound } from "./src/protocol";

async function main(): Promise<void> {
  const source = path.resolve(__dirname, "seed-data/sun_of_egypt.ndjson");
  const target = path.resolve(__dirname, "output/sun_of_egypt.import.ndjson");
  const lines = (await fs.readFile(source, "utf8")).split(/\r?\n/).filter(Boolean);
  const documents = lines.map((line) => {
    const document = JSON.parse(line);
    const validation = validateRound(document.data, Number(document.bet));
    const seedId = crypto.createHash("sha256").update(JSON.stringify(document.data)).digest("hex");
    return JSON.stringify({
      ...document,
      seedId,
      mul: validation.win / Number(document.bet),
      branches: validation.features,
      features: validation.features,
      captureVersion: 2,
      settlementField: "context.current.total_win",
      validation: { valid: true, cumulativeWins: validation.cumulativeWins },
      rtp: document.testOnly === true ? [] : document.rtp,
    });
  });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${documents.join("\n")}\n`);
  console.log(`已生成 ${documents.length} 条严格校验的 Mongo 导入文件：${target}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
