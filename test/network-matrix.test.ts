import assert from "node:assert/strict";
import test from "node:test";
import { buildRuns, DEVICE_PROFILES } from "../src/network-matrix";

test("network matrix 为基准语言生成四视口并为其他语言冷启动", () => {
  assert.deepEqual(buildRuns(["zh", "en", "en"]), [
    { locale: "en", profile: "desktop-1920" },
    { locale: "en", profile: "desktop-1366" },
    { locale: "en", profile: "mobile-portrait" },
    { locale: "en", profile: "mobile-landscape" },
    { locale: "zh", profile: "desktop-1366" },
  ]);
  assert.deepEqual(DEVICE_PROFILES["desktop-1920"].viewport, { width: 1920, height: 1080 });
  assert.deepEqual(DEVICE_PROFILES["mobile-portrait"].viewport, { width: 390, height: 844 });
  assert.equal(DEVICE_PROFILES["mobile-landscape"].isMobile, true);
});
