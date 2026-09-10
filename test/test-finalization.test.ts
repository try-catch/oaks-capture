import assert from "node:assert/strict";
import test from "node:test";
import { finalizeTestCapture } from "../src/test-finalization";

test("完成采集后顺序严格校验、正式审计和生成清单，凭据只走环境", () => {
  const calls: string[] = [];
  finalizeTestCapture("example", { OAKS_MONGO_URI: "test-placeholder" }, (script, args, env) => {
    calls.push(script);
    assert.equal(env.OAKS_TEST_MONGO_URI, "test-placeholder");
    assert.equal(args.includes("test-placeholder"), false);
    assert.equal(args[3], "10");
  });
  assert.deepEqual(calls, ["validate-data.ts", "audit-mongo.ts", "finalize-data.ts"]);
});

test("严格校验失败时不会执行 Mongo 审计或生成完成清单", () => {
  const calls: string[] = [];
  assert.throws(() => finalizeTestCapture("example", {OAKS_TEST_MONGO_URI: "test-placeholder"}, (script) => {
    calls.push(script); throw new Error("invalid protocol");
  }), /invalid protocol/);
  assert.deepEqual(calls, ["validate-data.ts"]);
});
