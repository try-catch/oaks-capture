import path from "node:path";
import { spawnSync } from "node:child_process";

export function finalizeTestCapture(
  slug: string,
  environment: NodeJS.ProcessEnv = process.env,
  run: (script: string, args: string[], env: NodeJS.ProcessEnv) => void = runTool,
): void {
  const uri = environment.OAKS_TEST_MONGO_URI || environment.OAKS_MONGO_URI;
  if (!uri) throw new Error("正式验收缺少测试服 Mongo 环境变量");
  const env = { ...environment, OAKS_TEST_MONGO_URI: uri };
  const args = ["--game", slug, "--target-per-feature", "10"];
  // 只有前一阶段通过才能继续，连接串只在子进程环境中传递。
  run("validate-data.ts", args, env);
  run("audit-mongo.ts", [...args, "--target", "test"], env);
  run("finalize-data.ts", [...args, "--target", "test"], env);
}

function runTool(script: string, args: string[], env: NodeJS.ProcessEnv): void {
  const root = path.resolve(__dirname, "..");
  const result = spawnSync(process.execPath, ["-r", "ts-node/register", path.join(root, script), ...args], {
    cwd: root, env, stdio: "inherit",
  });
  if (result.error || result.status !== 0) throw new Error(`${script} 正式验收失败，拒绝继续`);
}
