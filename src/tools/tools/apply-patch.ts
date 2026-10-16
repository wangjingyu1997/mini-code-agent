import type { ApplyPatchRequest, ApplyPatchResult } from "../../patch/patch-engine";
import { applyPatch } from "../../patch/patch-engine";
import { workspacePathResource } from "../resource";
import type { Tool } from "../tool";

export type ApplyPatchInput = ApplyPatchRequest;
export type ApplyPatchOutput = ApplyPatchResult;

function parseInput(input: unknown): ApplyPatchInput {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("apply_patch expects an object input");
  }

  if (!("path" in input) || typeof input.path !== "string" || input.path.trim() === "") {
    throw new TypeError("apply_patch expects { path: string }");
  }

  if (
    !("expectedHash" in input) ||
    typeof input.expectedHash !== "string" ||
    input.expectedHash.trim() === ""
  ) {
    throw new TypeError("apply_patch expects { expectedHash: string }");
  }

  if (!("replacements" in input) || !Array.isArray(input.replacements) || input.replacements.length === 0) {
    throw new TypeError("apply_patch expects a non-empty replacements array");
  }

  const replacements = input.replacements.map((replacement) => {
    if (
      typeof replacement !== "object" ||
      replacement === null ||
      !("oldText" in replacement) ||
      typeof replacement.oldText !== "string" ||
      !("newText" in replacement) ||
      typeof replacement.newText !== "string"
    ) {
      throw new TypeError("Each replacement expects { oldText: string, newText: string }");
    }

    return {
      oldText: replacement.oldText,
      newText: replacement.newText,
    };
  });

  return {
    path: input.path,
    expectedHash: input.expectedHash,
    replacements,
  };
}

export const applyPatchTool: Tool<ApplyPatchInput, ApplyPatchOutput> = {
  name: "apply_patch",
  description:
    "Safely edit one UTF-8 workspace file using an expected sha256 snapshot hash returned by read_file. Rejects stale or ambiguous edits.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path relative to the workspace root.",
      },
      expectedHash: {
        type: "string",
        description: "sha256 hash returned by read_file for the version being edited.",
      },
      replacements: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            oldText: {
              type: "string",
              description: "Exact text expected to occur once in the current snapshot.",
            },
            newText: {
              type: "string",
              description: "Replacement text.",
            },
          },
          required: ["oldText", "newText"],
          additionalProperties: false,
        },
      },
    },
    required: ["path", "expectedHash", "replacements"],
    additionalProperties: false,
  },

  validate: parseInput,

  plan(input, context) {
    return {
      resources: [
        {
          key: workspacePathResource(context.cwd, input.path),
          access: "write",
        },
      ],
      sideEffect: "filesystem",
      risk: "write",
    };
  },

  execute(input, context, signal) {
    return applyPatch(context.cwd, input, signal);
  },

  serialize(output) {
    return [
      `patched ${output.path}`,
      `before sha256:${output.beforeHash}`,
      `after sha256:${output.afterHash}`,
      `replacements:${output.replacementsApplied}`,
    ].join("\n");
  },
};
