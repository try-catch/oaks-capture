import { JSONMap, RoundValidation, validateCommonRound, validateSunJackpots } from "../protocol";

export function validateSunOfEgyptRound(frames: JSONMap[], bet: number): RoundValidation {
  const result = validateCommonRound(frames, bet);
  validateSunJackpots(frames, bet);
  return result;
}
