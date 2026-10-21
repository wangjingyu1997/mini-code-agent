import { realpath } from "node:fs/promises";
import type { ExecutionPlan, ResourceClaim } from "../contracts/tool";
import { GLOBAL_WORKSPACE_RESOURCE } from "./resource";

const PATH_RESOURCE_PREFIX = "workspace:path:";

/**
 * Normalize scheduler resource identity, not authorization.
 * Tool.execute() must still enforce workspace path/security boundaries.
 */
export interface ResourceResolverLike {
  resolve(plan: ExecutionPlan): Promise<ExecutionPlan>;
}

export class ResourceResolver implements ResourceResolverLike {
  async resolve(plan: ExecutionPlan): Promise<ExecutionPlan> {
    const resources = await Promise.all(
      plan.resources.map(async (claim): Promise<ResourceClaim> => {
        if (claim.key === GLOBAL_WORKSPACE_RESOURCE ||
            !claim.key.startsWith(PATH_RESOURCE_PREFIX)) {
          return claim;
        }

        const requestedPath = claim.key.slice(PATH_RESOURCE_PREFIX.length);
        // The current read/patch/list tools operate on existing paths.
        // Fail closed on ENOENT, EACCES, etc. instead of admitting a guessed
        // lexical key that might alias an already-running mutation.
        const canonicalPath = await realpath(requestedPath);
        return {
          key: PATH_RESOURCE_PREFIX + canonicalPath,
          access: claim.access,
        };
      }),
    );

    return { ...plan, resources };
  }
}
