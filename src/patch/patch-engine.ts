import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type FileSnapshot = Readonly<{
  path: string;
  content: string;
  hash: string;
}>;

export type TextReplacement = Readonly<{
  oldText: string;
  newText: string;
}>;

export type ApplyPatchRequest = Readonly<{
  path: string;
  expectedHash: string;
  replacements: readonly TextReplacement[];
}>;

export type ApplyPatchResult = Readonly<{
  path: string;
  beforeHash: string;
  afterHash: string;
  replacementsApplied: number;
}>;

export class StaleFileError extends Error {
  constructor(
    readonly filePath: string,
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super(
      `Stale file snapshot for ${filePath}: expected ${expectedHash}, current ${actualHash}`,
    );
    this.name = "StaleFileError";
  }
}

export function hashText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function resolveExistingInsideWorkspace(
  cwd: string,
  requestedPath: string,
): Promise<{ root: string; absolute: string }> {
  const root = await realpath(cwd);
  const lexicalAbsolute = path.resolve(root, requestedPath);
  const lexicalRelative = path.relative(root, lexicalAbsolute);

  if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }

  const absolute = await realpath(lexicalAbsolute);
  const realRelative = path.relative(root, absolute);

  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Path escapes workspace through symlink: ${requestedPath}`);
  }

  return { root, absolute };
}

export async function snapshotFile(
  cwd: string,
  requestedPath: string,
): Promise<FileSnapshot> {
  const { root, absolute } = await resolveExistingInsideWorkspace(cwd, requestedPath);
  const content = await readFile(absolute, "utf8");

  return {
    path: path.relative(root, absolute),
    content,
    hash: hashText(content),
  };
}

function replaceExactlyOnce(content: string, replacement: TextReplacement): string {
  if (replacement.oldText.length === 0) {
    throw new Error("Patch oldText must not be empty");
  }

  const first = content.indexOf(replacement.oldText);
  if (first === -1) {
    throw new Error("Patch oldText was not found in the current snapshot");
  }

  const second = content.indexOf(replacement.oldText, first + replacement.oldText.length);
  if (second !== -1) {
    throw new Error("Patch oldText is ambiguous because it appears more than once");
  }

  return `${content.slice(0, first)}${replacement.newText}${content.slice(
    first + replacement.oldText.length,
  )}`;
}

async function assertSnapshotStillCurrent(
  absolute: string,
  displayPath: string,
  expectedHash: string,
): Promise<void> {
  const current = await readFile(absolute, "utf8");
  const actualHash = hashText(current);
  if (actualHash !== expectedHash) {
    throw new StaleFileError(displayPath, expectedHash, actualHash);
  }
}

export async function applyPatch(
  cwd: string,
  request: ApplyPatchRequest,
  signal: AbortSignal,
): Promise<ApplyPatchResult> {
  if (signal.aborted) {
    throw signal.reason ?? new Error("Patch application aborted");
  }

  if (request.replacements.length === 0) {
    throw new Error("Patch requires at least one replacement");
  }

  const { root, absolute } = await resolveExistingInsideWorkspace(cwd, request.path);
  const beforeContent = await readFile(absolute, "utf8");
  const beforeHash = hashText(beforeContent);
  const displayPath = path.relative(root, absolute);

  if (beforeHash !== request.expectedHash) {
    throw new StaleFileError(displayPath, request.expectedHash, beforeHash);
  }

  let nextContent = beforeContent;
  for (const replacement of request.replacements) {
    nextContent = replaceExactlyOnce(nextContent, replacement);
  }

  if (signal.aborted) {
    throw signal.reason ?? new Error("Patch application aborted");
  }

  // Re-read immediately before commit. This catches edits that happened while
  // the patch was being prepared. Plain filesystems do not provide a portable
  // compare-and-swap primitive, so this narrows (but cannot completely remove)
  // the final check-to-rename race against arbitrary external writers.
  await assertSnapshotStillCurrent(absolute, displayPath, request.expectedHash);

  const afterHash = hashText(nextContent);
  if (afterHash === beforeHash) {
    return {
      path: displayPath,
      beforeHash,
      afterHash,
      replacementsApplied: request.replacements.length,
    };
  }

  const originalStat = await stat(absolute);
  const temporaryPath = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, nextContent, {
      encoding: "utf8",
      mode: originalStat.mode,
    });

    if (signal.aborted) {
      throw signal.reason ?? new Error("Patch application aborted");
    }

    await rename(temporaryPath, absolute);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  return {
    path: displayPath,
    beforeHash,
    afterHash,
    replacementsApplied: request.replacements.length,
  };
}
