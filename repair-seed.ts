import fs from "node:fs/promises";
import path from "node:path";
import { RTP_BUCKETS } from "./config";
import { DIRECTED_TEST_FEATURES, validateRound } from "./src/protocol";

async function main(): Promise<void> {
  const target = path.resolve(__dirname, "seed-data/sun_of_egypt.ndjson");
  const lines = (await fs.readFile(target, "utf8")).split(/\r?\n/).filter(Boolean);
  const repaired = lines.map((line) => {
    const document = JSON.parse(line);
    const validation = validateRound(document.data, Number(document.bet));
    // testOnly 必须由当前严格分类重新推导，避免旧版误标永久残留。
    const testOnly = DIRECTED_TEST_FEATURES.some((feature) => validation.features.includes(feature));
    return JSON.stringify({
      ...document,
      mul: validation.win / Number(document.bet),
      branches: validation.features,
      features: validation.features,
      captureVersion: 2,
      settlementField: "context.current.total_win",
      validation: { valid: true, cumulativeWins: validation.cumulativeWins },
      rtp: testOnly ? [] : (Array.isArray(document.rtp) && document.rtp.length > 0 ? document.rtp : RTP_BUCKETS),
      testOnly,
    });
  });
  await fs.writeFile(target, `${repaired.join("\n")}\n`);
  console.log(`已按当前局 total_win 重算并校验 ${repaired.length} 条种子数据`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
