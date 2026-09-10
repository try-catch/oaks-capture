import { RegistryGame } from "./catalog";

export interface GamePathState {
  serviceDirectory: boolean;
  staticDirectory: boolean;
  captureFile: boolean;
  validationReport: boolean;
  resourceAudit: boolean;
}

export interface GameStatus {
  gameId: number;
  slug: string;
  catalogued: boolean;
  discovered: boolean;
  resources: boolean;
  captured: boolean;
  validated: boolean;
  integrated: boolean;
}

export function computeGameStatus(game: RegistryGame, paths: GamePathState): GameStatus {
  const discovered = Boolean(game.discovery?.clientUrl && game.discovery?.serverTemplate);
  return {
    gameId: game.gameId,
    slug: game.slug,
    catalogued: game.active,
    discovered,
    resources: paths.resourceAudit,
    captured: paths.captureFile,
    validated: paths.validationReport,
    integrated: paths.serviceDirectory && paths.resourceAudit && paths.validationReport,
  };
}
