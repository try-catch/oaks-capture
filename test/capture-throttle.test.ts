import assert from "node:assert/strict";
import test from "node:test";
import { CaptureThrottle } from "../src/capture-throttle";
import { ProtocolHttpError } from "../src/protocol";

test("capture throttle 默认三秒且重复限流后降级为五秒", () => {
  const throttle = new CaptureThrottle({ spinDelayMs: 3_000, fallbackSpinDelayMs: 5_000 });

  assert.equal(throttle.spinDelayMs, 3_000);
  assert.equal(throttle.recordRateLimit(new ProtocolHttpError("429", 429, 35_000), "sun_of_egypt"), 35_000);
  assert.equal(throttle.spinDelayMs, 3_000);
  assert.equal(throttle.recordRateLimit(new ProtocolHttpError("429", 429, 120_000), "sun_of_egypt"), 120_000);
  assert.equal(throttle.spinDelayMs, 5_000);
  assert.deepEqual(throttle.events.map(({ slug, waitMs }) => ({ slug, waitMs })), [
    { slug: "sun_of_egypt", waitMs: 35_000 },
    { slug: "sun_of_egypt", waitMs: 120_000 },
  ]);
});

test("capture throttle 不缩短 Retry-After 且忽略非 429 错误", () => {
  const throttle = new CaptureThrottle({ spinDelayMs: 3_000, fallbackSpinDelayMs: 5_000 });

  assert.equal(throttle.recordRateLimit(new ProtocolHttpError("429", 429, 1_000), "grand"), 10_000);
  assert.equal(throttle.recordRateLimit(new ProtocolHttpError("500", 500, 60_000), "grand"), 0);
  assert.equal(throttle.recordRateLimit(new Error("network"), "grand"), 0);
  assert.equal(throttle.events.length, 1);
});

test("capture throttle 拒绝非法等待配置", () => {
  assert.throws(() => new CaptureThrottle({ spinDelayMs: -1, fallbackSpinDelayMs: 5_000 }), /非法采集等待值/);
  assert.throws(() => new CaptureThrottle({ spinDelayMs: 3_000, fallbackSpinDelayMs: Number.NaN }), /非法采集等待值/);
});
