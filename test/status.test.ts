import assert from "node:assert/strict";
import test from "node:test";
import { emptyRegistry } from "../src/catalog";
import { computeGameStatus } from "../src/status";

test("status 不把仅有目录或仅有采集误报为已接入", () => {
  const game = emptyRegistry().games[0];
  const catalogOnly = computeGameStatus(game, { serviceDirectory: false, staticDirectory: false, captureFile: false, validationReport: false, resourceAudit: false });
  assert.equal(catalogOnly.integrated, false);
  const validated = computeGameStatus(game, { serviceDirectory: true, staticDirectory: true, captureFile: true, validationReport: true, resourceAudit: true });
  assert.equal(validated.validated, true);
  assert.equal(validated.integrated, true);
});
