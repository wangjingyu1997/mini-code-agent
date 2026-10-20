import {
  applyPatchSet,
  type ApplyPatchRequest,
  type ApplyPatchResult,
} from "../../patch/patch-engine";
import { conservativeExecutionPlan } from "../resource";
import type { Tool } from "../tool";

export type ApplyPatchSetInput = Readonly<{
  files: readonly ApplyPatchRequest[];
}>;

function parseInput(value: unknown): ApplyPatchSetInput {
  if (typeof value !== "object" || value === null ||
      !("files" in value) || !Array.isArray(value.files) ||
      value.files.length === 0) {
    throw new TypeError("apply_patch_set expects { files: non-empty array }");
  }

  const files = value.files.map((file: unknown): ApplyPatchRequest => {
    if (typeof file !== "object" || file === null ||
        !("path" in file) || typeof file.path !== "string" || !file.path.trim() ||
        !("expectedHash" in file) || typeof file.expectedHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(file.expectedHash) ||
        !("replacements" in file) || !Array.isArray(file.replacements) ||
        file.replacements.length === 0) {
      throw new TypeError("Each patch file requires path, expectedHash and replacements");
    }

    const replacements = file.replacements.map((r: unknown) => {
      if (typeof r !== "object" || r === null ||
          !("oldText" in r) || typeof r.oldText !== "string" || !r.oldText ||
          !("newText" in r) || typeof r.newText !== "string") {
        throw new TypeError("Replacement requires non-empty oldText and newText");
      }
      return { oldText: r.oldText, newText: r.newText };
    });

    return { path: file.path, expectedHash: file.expectedHash, replacements };
  });

  return { files };
}

export const applyPatchSetTool: Tool<ApplyPatchSetInput, readonly ApplyPatchResult[]> = {
  name: "apply_patch_set",
  description:
    "Edit multiple existing UTF-8 files. Every file is preflighted against a " +
    "read_file sha256 snapshot before any changes; partial commits receive " +
    "best-effort conditional rollback. Not an atomic cross-file transaction.",
  inputSchema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            expectedHash: { type: "string", description: "sha256 from read_file" },
            replacements: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  oldText: { type: "string" },
                  newText: { type: "string" },
                },
                required: ["oldText", "newText"],
                additionalProperties: false,
              },
            },
          },
          required: ["path", "expectedHash", "replacements"],
          additionalProperties: false,
        },
      },
    },
    required: ["files"],
    additionalProperties: false,
  },

  validate: parseInput,

  plan() {
    // Cross-file updates conservatively claim the entire workspace because
    // filesystem aliases and other tools may touch these same files.
    return conservativeExecutionPlan;
  },

  execute(input, context, signal) {
    return applyPatchSet(context.cwd, input.files, signal);
  },

  serialize(results) {
    return results.map((result) =>
      "patched " + result.path + "\n" +
      "before sha256:" + result.beforeHash + "\n" +
      "after sha256:" + result.afterHash + "\n" +
      "replacements:" + result.replacementsApplied,
    ).join("\n---\n");
  },
};
