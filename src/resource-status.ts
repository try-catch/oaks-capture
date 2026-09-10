export interface ResourceStatusInput {
  closureFailed: number;
  networkFailed: number;
  missingLocales: string[];
  missingProfiles: string[];
  missingFiles: string[];
  hashMismatches: string[];
  emptyFiles: string[];
}

export interface ResourceStatus extends ResourceStatusInput {
  complete: boolean;
}

export function computeResourceStatus(input: ResourceStatusInput): ResourceStatus {
  return {
    ...input,
    complete: input.closureFailed === 0 && input.networkFailed === 0 && input.missingLocales.length === 0 &&
      input.missingProfiles.length === 0 && input.missingFiles.length === 0 && input.hashMismatches.length === 0 &&
      input.emptyFiles.length === 0,
  };
}
