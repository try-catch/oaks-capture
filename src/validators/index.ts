import { RegistryGame } from "../catalog";
import { JSONMap, RoundValidation } from "../protocol";
import { validateCommonRound } from "./common";
import { validateSunOfEgyptRound } from "./sun-of-egypt";

export function validateGameRound(game: RegistryGame, frames: JSONMap[], bet: number): RoundValidation {
  return game.validator === "sun-of-egypt" ? validateSunOfEgyptRound(frames, bet) : validateCommonRound(frames, bet);
}
