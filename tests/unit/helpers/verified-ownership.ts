import type { VerifiedOwnership } from '../../../src/main/project-ownership/project-ownership';

/**
 * The proof the sweeps take, for a test of the sweep itself. Whether a proof is
 * granted is `project-ownership.test.ts`'s business.
 */
export function ownershipOf(projectPath: string): VerifiedOwnership {
  return { projectPath } as VerifiedOwnership;
}
