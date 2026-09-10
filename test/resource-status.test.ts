import assert from "node:assert/strict";
import test from "node:test";
import { computeResourceStatus } from "../src/resource-status";

const completeInput = {
  closureFailed: 0,
  networkFailed: 0,
  missingLocales: [] as string[],
  missingProfiles: [] as string[],
  missingFiles: [] as string[],
  hashMismatches: [] as string[],
  emptyFiles: [] as string[],
};

test("resource status 任一资源、语言、视口或 SHA 缺失都不能通过", () => {
  assert.equal(computeResourceStatus(completeInput).complete, true);
  assert.equal(computeResourceStatus({ ...completeInput, missingLocales: ["uk"] }).complete, false);
  assert.equal(computeResourceStatus({ ...completeInput, missingProfiles: ["mobile-landscape"] }).complete, false);
  assert.equal(computeResourceStatus({ ...completeInput, closureFailed: 1 }).complete, false);
  assert.equal(computeResourceStatus({ ...completeInput, networkFailed: 1 }).complete, false);
  assert.equal(computeResourceStatus({ ...completeInput, missingFiles: ["a.png"] }).complete, false);
  assert.equal(computeResourceStatus({ ...completeInput, hashMismatches: ["a.png"] }).complete, false);
  assert.equal(computeResourceStatus({ ...completeInput, emptyFiles: ["a.png"] }).complete, false);
});
