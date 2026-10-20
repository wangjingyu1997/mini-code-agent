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

export type PreparedPatch = Readonly<{
  path: string;
  absolute: string;
  requestedAbsolute: string;
  beforeContent: string;
  nextContent: string;
  beforeHash: string;
  afterHash: string;
  mode: number;
  replacementsApplied: number;
}>;

export type PreparedPatchSet = Readonly<{
  root: string;
  patches: readonly PreparedPatch[];
}>;

// Injection seam for failure tests; never exposed as a model tool parameter.
export type PatchCommitOptions = Readonly<{
  beforeRename?: (path: string, index: number) => Promise<void> | void;
}>;

export class StaleFileError extends Error {
  constructor(
    readonly filePath: string,
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super("Stale file snapshot for " + filePath +
      ": expected " + expectedHash + ", current " + actualHash);
    this.name = "StaleFileError";
  }
}

export class PatchSetCommitError extends Error {
  readonly committedPaths: readonly string[];
  readonly rolledBackPaths: readonly string[];
  readonly unrecoveredPaths: readonly string[];

  constructor(
    cause: unknown,
    committedPaths: readonly string[],
    rolledBackPaths: readonly string[],
    unrecoveredPaths: readonly string[],
  ) {
    super("Patch set commit failed after " + committedPaths.length +
      " file(s); rolled back " + rolledBackPaths.length +
      ", needs inspection " + unrecoveredPaths.length, { cause });
    this.name = "PatchSetCommitError";
    this.committedPaths = committedPaths;
    this.rolledBackPaths = rolledBackPaths;
    this.unrecoveredPaths = unrecoveredPaths;
  }
}

export function hashText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function resolveExistingInsideWorkspace(
  cwd: string,
  requestedPath: string,
): Promise<{ root: string; absolute: string; requestedAbsolute: string }> {
  const root = await realpath(cwd);
  const requestedAbsolute = path.resolve(root, requestedPath);
  const lexicalRelative = path.relative(root, requestedAbsolute);
  if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    throw new Error("Path escapes workspace: " + requestedPath);
  }

  const absolute = await realpath(requestedAbsolute);
  const realRelative = path.relative(root, absolute);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("Path escapes workspace through symlink: " + requestedPath);
  }

  const metadata = await stat(absolute);
  if (!metadata.isFile()) {
    throw new Error("Patch target is not a regular file: " + requestedPath);
  }

  return { root, absolute, requestedAbsolute };
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
  return content.slice(0, first) + replacement.newText +
    content.slice(first + replacement.oldText.length);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error("Patch application aborted");
  }
}

async function assertPreparedSnapshotCurrent(patch: PreparedPatch): Promise<void> {
  // Check the requested symlink/path still targets the exact same resolved file.
  const resolved = await realpath(patch.requestedAbsolute);
  if (resolved !== patch.absolute) {
    throw new Error("Patch target changed during commit: " + patch.path);
  }
  const actualHash = hashText(await readFile(patch.absolute, "utf8"));
  if (actualHash !== patch.beforeHash) {
    throw new StaleFileError(patch.path, patch.beforeHash, actualHash);
  }
}

/**
 * Build every edit fully in memory before writing anything to the workspace.
 * A validation failure in any file leaves all files unchanged.
 */
export async function preparePatchSet(
  cwd: string,
  requests: readonly ApplyPatchRequest[],
  signal: AbortSignal,
): Promise<PreparedPatchSet> {
  assertNotAborted(signal);
  if (requests.length === 0) {
    throw new Error("Patch set requires at least one file");
  }

  const root = await realpath(cwd);
  const seen = new Set<string>();
  const patches: PreparedPatch[] = [];

  for (const request of requests) {
    assertNotAborted(signal);
    if (request.replacements.length === 0) {
      throw new Error("Patch requires at least one replacement: " + request.path);
    }

    const target = await resolveExistingInsideWorkspace(root, request.path);
    if (seen.has(target.absolute)) {
      throw new Error("Duplicate patch target: " + request.path);
    }
    seen.add(target.absolute);

    const beforeContent = await readFile(target.absolute, "utf8");
    const beforeHash = hashText(beforeContent);
    const displayPath = path.relative(root, target.absolute);
    if (beforeHash !== request.expectedHash) {
      throw new StaleFileError(displayPath, request.expectedHash, beforeHash);
    }

    let nextContent = beforeContent;
    for (const replacement of request.replacements) {
      nextContent = replaceExactlyOnce(nextContent, replacement);
    }
    const metadata = await stat(target.absolute);
    patches.push({
      path: displayPath,
      absolute: target.absolute,
      requestedAbsolute: target.requestedAbsolute,
      beforeContent,
      nextContent,
      beforeHash,
      afterHash: hashText(nextContent),
      mode: metadata.mode & 0o777,
      replacementsApplied: request.replacements.length,
    });
  }

  assertNotAborted(signal);
  return { root, patches };
}

function tempPath(absolute: string): string {
  return path.join(
    path.dirname(absolute),
    "." + path.basename(absolute) + "." + randomUUID() + ".tmp",
  );
}

/**
 * Best-effort multi-file commit, NOT an atomic filesystem transaction.
 *
 * - Stage every changed file in its target directory before any rename.
 * - Recheck all snapshots, and recheck a target just before its rename.
 * - If a later rename fails, roll back already changed files only when their
 *   content still equals our committed version.
 *
 * Concurrent noncooperating processes can write between check and rename.
 * Other readers can observe partial commits; crashes cannot be recovered yet.
 */
export async function commitPatchSet(
  prepared: PreparedPatchSet,
  signal: AbortSignal,
  options: PatchCommitOptions = {},
): Promise<readonly ApplyPatchResult[]> {
  assertNotAborted(signal);

  const staged = new Map<string, string>();
  const committed: PreparedPatch[] = [];
  const rolledBackPaths: string[] = [];
  const unrecoveredPaths: string[] = [];

  try {
    // STAGE: no workspace targets replaced yet.
    for (const patch of prepared.patches) {
      assertNotAborted(signal);
      if (patch.beforeHash === patch.afterHash) continue;
      const temp = tempPath(patch.absolute);
      staged.set(patch.absolute, temp);
      await writeFile(temp, patch.nextContent, {
        encoding: "utf8",
        mode: patch.mode,
        flag: "wx",
      });
    }

    // PREFLIGHT: a stale file anywhere must stop before the first rename.
    for (const patch of prepared.patches) {
      assertNotAborted(signal);
      await assertPreparedSnapshotCurrent(patch);
    }

    // COMMIT: each rename is individually atomic (on supported filesystems);
    // the sequence is not atomic as a group.
    for (const [index, patch] of prepared.patches.entries()) {
      assertNotAborted(signal);
      if (patch.beforeHash === patch.afterHash) continue;
      await options.beforeRename?.(patch.path, index);
      // Detect changed input after a delay/injected failure boundary.
      await assertPreparedSnapshotCurrent(patch);
      assertNotAborted(signal);
      await rename(staged.get(patch.absolute)!, patch.absolute);
      staged.delete(patch.absolute);
      committed.push(patch);
    }
  } catch (cause) {
    if (committed.length === 0) throw cause;

    // Compensating rollback after a partial commit. Do not overwrite an
    // unexpected external edit of a file that was already committed.
    for (const patch of [...committed].reverse()) {
      let rollbackTemp: string | undefined;
      try {
        const actualHash = hashText(await readFile(patch.absolute, "utf8"));
        if (actualHash !== patch.afterHash) {
          unrecoveredPaths.push(patch.path);
          continue;
        }
        rollbackTemp = tempPath(patch.absolute);
        await writeFile(rollbackTemp, patch.beforeContent, {
          encoding: "utf8",
          mode: patch.mode,
          flag: "wx",
        });
        // Second check reduces, but does not eliminate, rollback TOCTOU.
        if (hashText(await readFile(patch.absolute, "utf8")) !== patch.afterHash) {
          unrecoveredPaths.push(patch.path);
          continue;
        }
        await rename(rollbackTemp, patch.absolute);
        rolledBackPaths.push(patch.path);
      } catch {
        unrecoveredPaths.push(patch.path);
      } finally {
        if (rollbackTemp) await unlink(rollbackTemp).catch(() => undefined);
      }
    }

    throw new PatchSetCommitError(
      cause,
      committed.map((patch) => patch.path),
      rolledBackPaths,
      unrecoveredPaths,
    );
  } finally {
    for (const temporary of staged.values()) {
      await unlink(temporary).catch(() => undefined);
    }
  }

  return prepared.patches.map((patch) => ({
    path: patch.path,
    beforeHash: patch.beforeHash,
    afterHash: patch.afterHash,
    replacementsApplied: patch.replacementsApplied,
  }));
}

export async function applyPatchSet(
  cwd: string,
  requests: readonly ApplyPatchRequest[],
  signal: AbortSignal,
): Promise<readonly ApplyPatchResult[]> {
  const prepared = await preparePatchSet(cwd, requests, signal);
  return commitPatchSet(prepared, signal);
}

// Compatibility with the existing single-file tool and its callers.
export async function applyPatch(
  cwd: string,
  request: ApplyPatchRequest,
  signal: AbortSignal,
): Promise<ApplyPatchResult> {
  const results = await applyPatchSet(cwd, [request], signal);
  return results[0]!;
}
