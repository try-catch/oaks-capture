import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeCapturedDocument } from "../sanitize-output";
import { sourceRoundHash } from "../src/mongo-store";

test("输出修复删除会话字段并重算真实协议哈希", () => {
  const document = {
    gameId: 32601,
    game: "sun_of_egypt",
    token: "must-not-remain",
    sourceRoundHash: "stale",
    data: [{
      request_id: "request-1",
      session_id: "session-1",
      user: { huid: "user-1", balance: 100 },
      context: { round_finished: true },
    }],
  };
  const sanitized = sanitizeCapturedDocument(document);
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /request_id|session_id|huid|token/);
  assert.equal(sanitized.sourceRoundHash, sourceRoundHash(sanitized));
  assert.equal((sanitized.data as any[])[0].user.balance, 100);
});
