import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readRegistry } from "./catalog-sync";
import { renderPlatform, replaceServiceRegions } from "./src/codegen";

async function writeIfChanged(filename: string, content: string): Promise<void> {
  const prior = await fs.readFile(filename, "utf8").catch(() => "");
  if (prior === content) return;
  await fs.writeFile(filename, content);
}

async function main(): Promise<void> {
  const commonRoot = path.resolve(__dirname, "..", "..", "..", "api.common");
  const servicePath = path.join(commonRoot, "service", "service.go");
  const oaksPath = path.join(commonRoot, "service", "oaks.go");
  const chipsPath = path.join(commonRoot, "chips", "chips_oaks", "chips_oaks.go");
  const rendered = renderPlatform(await readRegistry());
  const serviceSource = await fs.readFile(servicePath, "utf8");
  await writeIfChanged(servicePath, replaceServiceRegions(serviceSource, rendered));
  await writeIfChanged(oaksPath, rendered.serviceFile);
  await writeIfChanged(chipsPath, rendered.chipsFile);
  const formatted = spawnSync("gofmt", ["-w", servicePath, oaksPath, chipsPath], { stdio: "inherit" });
  if (formatted.status !== 0) throw new Error(`gofmt 失败，退出码 ${formatted.status}`);
  console.log(`3 OAKS 平台配置已生成：${rendered.gameInfoCount} 款`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
