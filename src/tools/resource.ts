import path from "node:path";
import type { ExecutionPlan, ResourceClaim } from "../contracts/tool";

export const GLOBAL_WORKSPACE_RESOURCE = "workspace:*";

export function workspacePathResource(cwd: string, requestedPath: string): string {
  return `workspace:path:${path.resolve(cwd, requestedPath)}`;
}

export function claimsConflict(a: ResourceClaim, b: ResourceClaim): boolean {
  const sameResource =
    a.key === b.key ||
    a.key === GLOBAL_WORKSPACE_RESOURCE ||
    b.key === GLOBAL_WORKSPACE_RESOURCE;

  if (!sameResource) {
    return false;
  }

  return a.access === "write" || b.access === "write";
}

export function plansConflict(a: ExecutionPlan, b: ExecutionPlan): boolean {
  return a.resources.some((left) =>
    b.resources.some((right) => claimsConflict(left, right)),
  );
}

export const conservativeExecutionPlan: ExecutionPlan = {
  resources: [{ key: GLOBAL_WORKSPACE_RESOURCE, access: "write" }],
  sideEffect: "external",
  risk: "write",
};
