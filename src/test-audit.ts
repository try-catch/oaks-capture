import { RegistryGame } from "./catalog";
import { capacityGate, OpsSystemInfo } from "./deploy-plan";

export interface TestListGame {
  gameId: number;
  provider: string;
  sourceId: string;
  status: number;
}

export interface TestService {
  id: string;
  platform?: string;
  gameId?: number;
  status: string;
  pid: number;
  version?: string;
  sha256?: string;
  controllable?: boolean;
}

export function auditTestList(registryGames: RegistryGame[], liveGames: TestListGame[]): Record<string, unknown> {
  const expected = registryGames.filter((game) => game.active).sort((left, right) => left.gameId - right.gameId);
  const actual = liveGames.filter((game) => game.provider.toUpperCase() === "OAKS").sort((left, right) => left.gameId - right.gameId);
  const duplicateIds = actual.filter((game, index) => actual.findIndex((candidate) => candidate.gameId === game.gameId) !== index).map((game) => game.gameId);
  const duplicateSlugs = actual.filter((game, index) => actual.findIndex((candidate) => candidate.sourceId === game.sourceId) !== index).map((game) => game.sourceId);
  const actualByID = new Map(actual.map((game) => [game.gameId, game]));
  const missing = expected.filter((game) => !actualByID.has(game.gameId)).map((game) => game.slug);
  const mismatched = expected.flatMap((game) => {
    const current = actualByID.get(game.gameId);
    return current && current.sourceId !== game.slug ? [{ gameId: game.gameId, expected: game.slug, actual: current.sourceId }] : [];
  });
  const unexpected = actual.filter((game) => !expected.some((candidate) => candidate.gameId === game.gameId)).map((game) => ({ gameId: game.gameId, slug: game.sourceId }));
  const disabled = actual.filter((game) => game.status !== 1).map((game) => game.sourceId);
  return {
    provider: "OAKS", brandDisplay: "3 OAKS", expected: expected.length, actual: actual.length,
    duplicateIds: [...new Set(duplicateIds)], duplicateSlugs: [...new Set(duplicateSlugs)], missing, mismatched, unexpected, disabled,
    valid: expected.length === actual.length && duplicateIds.length === 0 && duplicateSlugs.length === 0 && missing.length === 0 && mismatched.length === 0 && unexpected.length === 0 && disabled.length === 0,
  };
}

export function auditServices(registryGames: RegistryGame[], services: TestService[], system: OpsSystemInfo): Record<string, unknown> {
  const expected = registryGames.filter((game) => game.active);
  const byID = new Map(services.map((service) => [service.id, service]));
  const missing: string[] = [];
  const unhealthy: Array<{ serviceId: string; status: string; pid: number }> = [];
  const wrongPlatform: string[] = [];
  const unversioned: string[] = [];
  for (const game of expected) {
    const serviceId = `game-${game.gameId}`;
    const service = byID.get(serviceId);
    if (!service) { missing.push(serviceId); continue; }
    if (service.status !== "running" || service.pid <= 0 || service.controllable === false) unhealthy.push({ serviceId, status: service.status, pid: service.pid });
    if ((service.platform ?? "").toUpperCase() !== "OAKS") wrongPlatform.push(serviceId);
    if (!service.version || !service.sha256) unversioned.push(serviceId);
  }
  const capacity = capacityGate(system);
  return {
    expected: expected.length, found: expected.length - missing.length, missing, unhealthy, wrongPlatform, unversioned, capacity,
    valid: missing.length === 0 && unhealthy.length === 0 && wrongPlatform.length === 0 && unversioned.length === 0 && capacity.pass,
  };
}
