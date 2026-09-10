import test from 'node:test';
import assert from 'node:assert/strict';
import { includeObservedFeatures, FeatureInventory } from '../src/features';
import { coverageComplete } from '../src/capture-checkpoint';

test('初始清单为空时，实际出现的重转分支必须达到十条', () => {
  const inventory: FeatureInventory = { schemaVersion: 2, buyModesFingerprint: '', declared: [], playable: ['base'], observed: [], required: [] };
  const frames = [{ context: { current: 'respins', respins: { rounds_left: 2 } } }];
  assert.equal(includeObservedFeatures(inventory, frames), true);
  assert.deepEqual(inventory.required, ['respin']);
  assert.equal(coverageComplete(inventory.required, { respin: 1 }, 10), false);
  assert.equal(coverageComplete(inventory.required, { respin: 10 }, 10), true);
  assert.equal(includeObservedFeatures(inventory, frames), false);
});

test('current 仍为 spins 时，已执行的官方 respin 动作同样进入验收清单', () => {
  const inventory: FeatureInventory = { schemaVersion: 2, buyModesFingerprint: '', declared: [], playable: ['base'], observed: [], required: [] };
  includeObservedFeatures(inventory, [{ context: { current: 'spins', last_action: 'respin' } }]);
  assert.deepEqual(inventory.required, ['respin']);
});
