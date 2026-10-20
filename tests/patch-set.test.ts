import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyPatchSet,
  commitPatchSet,
  hashText,
  PatchSetCommitError,
  preparePatchSet,
  StaleFileError,
  type ApplyPatchRequest,
} from "../src/patch/patch-engine";
import { applyPatchSetTool } from "../src/tools/tools/apply-patch-set";

const signal = () => new AbortController().signal;

const patch = (file: string, oldText: string, newText: string): ApplyPatchRequest => ({
  path: file,
  expectedHash: hashText(oldText),
  replacements: [{ oldText, newText }],
});

async function workspace(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-patch-set-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("preflight all files before any mutation", async (t) => {
  const cwd = await workspace(t);
  await writeFile(path.join(cwd, "a.ts"), "old-a", "utf8");
  await writeFile(path.join(cwd, "b.ts"), "old-b", "utf8");

  const requests = [
    patch("a.ts", "old-a", "new-a"),
    patch("b.ts", "not-the-current-content", "new-b"),
  ];

  await assert.rejects(() => applyPatchSet(cwd, requests, signal()), StaleFileError);
  assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "old-a");
  assert.equal(await readFile(path.join(cwd, "b.ts"), "utf8"), "old-b");
});

test("prepare then commit edits multiple files and preserves order", async (t) => {
  const cwd = await workspace(t);
  await writeFile(path.join(cwd, "a.ts"), "old-a", "utf8");
  await writeFile(path.join(cwd, "b.ts"), "old-b", "utf8");

  const prepared = await preparePatchSet(cwd, [
    patch("a.ts", "old-a", "new-a"),
    patch("b.ts", "old-b", "new-b"),
  ], signal());
  assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "old-a");

  const results = await commitPatchSet(prepared, signal());
  assert.deepEqual(results.map((result) => result.path), ["a.ts", "b.ts"]);
  assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "new-a");
  assert.equal(await readFile(path.join(cwd, "b.ts"), "utf8"), "new-b");
});

test("pre-commit stale snapshot aborts the entire patch set", async (t) => {
  const cwd = await workspace(t);
  await writeFile(path.join(cwd, "a.ts"), "old-a", "utf8");
  await writeFile(path.join(cwd, "b.ts"), "old-b", "utf8");

  const prepared = await preparePatchSet(cwd, [
    patch("a.ts", "old-a", "new-a"),
    patch("b.ts", "old-b", "new-b"),
  ], signal());

  await writeFile(path.join(cwd, "b.ts"), "updated-by-user", "utf8");
  await assert.rejects(() => commitPatchSet(prepared, signal()), StaleFileError);

  assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "old-a");
  assert.equal(await readFile(path.join(cwd, "b.ts"), "utf8"), "updated-by-user");
});

test("rejects aliased paths to the same underlying file", async (t) => {
  const cwd = await workspace(t);
  await writeFile(path.join(cwd, "a.ts"), "original", "utf8");
  await symlink("a.ts", path.join(cwd, "alias.ts"));

  await assert.rejects(
    () => preparePatchSet(cwd, [
      patch("a.ts", "original", "replacement"),
      patch("alias.ts", "original", "replacement2"),
    ], signal()),
    /Duplicate patch target/,
  );
});

test("failure after first rename triggers conditional best-effort rollback", async (t) => {
  const cwd = await workspace(t);
  await writeFile(path.join(cwd, "a.ts"), "old-a", "utf8");
  await writeFile(path.join(cwd, "b.ts"), "old-b", "utf8");

  const prepared = await preparePatchSet(cwd, [
    patch("a.ts", "old-a", "new-a"),
    patch("b.ts", "old-b", "new-b"),
  ], signal());

  await assert.rejects(
    () => commitPatchSet(prepared, signal(), {
      beforeRename(_path, index) {
        if (index === 1) throw new Error("injected failure");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof PatchSetCommitError);
      assert.deepEqual(error.committedPaths, ["a.ts"]);
      assert.deepEqual(error.rolledBackPaths, ["a.ts"]);
      assert.deepEqual(error.unrecoveredPaths, []);
      return true;
    },
  );

  assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "old-a");
  assert.equal(await readFile(path.join(cwd, "b.ts"), "utf8"), "old-b");
});

test("rollback does not overwrite an external edit after a partial commit", async (t) => {
  const cwd = await workspace(t);
  await writeFile(path.join(cwd, "a.ts"), "old-a", "utf8");
  await writeFile(path.join(cwd, "b.ts"), "old-b", "utf8");
  const prepared = await preparePatchSet(cwd, [
    patch("a.ts", "old-a", "new-a"),
    patch("b.ts", "old-b", "new-b"),
  ], signal());

  await assert.rejects(
    () => commitPatchSet(prepared, signal(), {
      async beforeRename(_path, index) {
        if (index === 1) {
          await writeFile(path.join(cwd, "a.ts"), "external-change", "utf8");
          throw new Error("injected failure");
        }
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof PatchSetCommitError);
      assert.deepEqual(error.rolledBackPaths, []);
      assert.deepEqual(error.unrecoveredPaths, ["a.ts"]);
      return true;
    },
  );
  assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "external-change");
  assert.equal(await readFile(path.join(cwd, "b.ts"), "utf8"), "old-b");
});

test("apply_patch_set tool validates schema and claims global workspace", async (t) => {
  const cwd = await workspace(t);
  await writeFile(path.join(cwd, "a.ts"), "old-a", "utf8");
  await writeFile(path.join(cwd, "b.ts"), "old-b", "utf8");

  const input = applyPatchSetTool.validate({
    files: [patch("a.ts", "old-a", "new-a"), patch("b.ts", "old-b", "new-b")],
  });
  assert.equal(applyPatchSetTool.plan(input, {
    cwd, sessionId: "s", turnId: "t", stepId: "x",
  }).resources[0]?.key, "workspace:*");

  const results = await applyPatchSetTool.execute(
    input, { cwd, sessionId: "s", turnId: "t", stepId: "x" }, signal(),
  );
  assert.equal(results.length, 2);
  assert.match(applyPatchSetTool.serialize(results), /patched a.ts/);
  assert.throws(() => applyPatchSetTool.validate({ files: [] }), /non-empty/);
});
