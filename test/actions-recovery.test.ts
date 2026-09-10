import assert from 'node:assert/strict';
import test from 'node:test';
import { playRound } from '../oaks';
import { installCaptureRuntime, PendingRound } from '../src/capture-runtime';
import type { Session } from '../src/protocol';
import type { PlayAction } from '../src/shop';

test('恢复特殊局时复用已有帧和会话，不重新发起基础 spin', async () => {
  const session = { endpoint: 'https://example.test', cookie: '', sessionId: 'fixture', defaultBet: 1 } as Session;
  const action = { name: 'spin', params: {} } as PlayAction;
  const first = { context: { actions: ['respin'], round_finished: false } };
  let pending: PendingRound | undefined = { id: 'fixture-round', session, action, frames: [first] };
  const steps: number[] = [];
  const original = globalThis.fetch;
  installCaptureRuntime({ pending: () => pending, savePending: value => { pending = value; },
    requestStep: (_id, step) => { steps.push(step); }, writeDocument() {}, acknowledge() {}, syncFiles() {}, shouldStop: () => false });
  const calls: any[] = [];
  globalThis.fetch = async (_input, options) => {
    calls.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify({ context: { round_finished: true, actions: ['spin'] } }), { status: 200 });
  };
  try {
    const frames = await playRound(session, action);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action.name, 'respin');
    assert.equal(calls[0].session_id, 'fixture');
    assert.equal(frames.length, 2);
    assert.deepEqual(steps, [1, 1]);
  } finally { globalThis.fetch = original; installCaptureRuntime(undefined); }
});
