import { JSONMap, RoundValidation, validateCommonRound as validate } from "../protocol";

export function validateCommonRound(frames: JSONMap[], bet: number): RoundValidation {
  return validate(frames, bet);
}
