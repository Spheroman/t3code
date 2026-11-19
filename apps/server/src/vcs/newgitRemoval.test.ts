// @effect-diagnostics nodeBuiltinImport:off - probes for the newgit binary synchronously to decide whether to skip.
// newgit fork patch: deleting a thread runs `newgit remove`, which refuses, deleting nothing,
// when the removal would lose what no checkpoint holds, such as a stopped database's dump.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { removeNewgitWorkspace, stopNewgitInstance } from "./newgitWorkspaces.ts";

const newgitBin = process.env.T3CODE_NEWGIT_BIN || "newgit";
const newgitAvailable = NodeChildProcess.spawnSync(newgitBin, ["--version"]).status === 0;

const swapNewgitBin = (value: string | undefined) => {
  const previous = process.env.T3CODE_NEWGIT_BIN;
  if (value === undefined) delete process.env.T3CODE_NEWGIT_BIN;
  else process.env.T3CODE_NEWGIT_BIN = value;
  return previous;
};

const REFUSAL =
  "Error: not removing `feature`: the capture of `db` (its checkpoint command exited with 2) " +
  "failed, and its state is in the workspace. `newgit start feature` brings it back";

// A present workspace for `feature`, and a fake newgit that logs its arguments, then refuses
// each `remove` until the `removeOkAt`th, and starts what `started` names.
const setup = (input: {
  readonly removeOkAt: number;
  readonly started: ReadonlyArray<string>;
  readonly evicted?: boolean;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped();
    const storeRoot = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    yield* fileSystem.makeDirectory(path.join(dir, ".newgit", "local"), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(dir, ".newgit", "local", "instance.toml"),
      `branch = "feature"\nstore_root = "${storeRoot}"\n`,
    );
    if (input.evicted !== true) yield* fileSystem.makeDirectory(path.join(dir, ".git"));
    const log = path.join(storeRoot, "calls.log");
    const started = JSON.stringify({
      instance: "feature",
      resources: input.started.map((name) => ({ name, action: "start", status: "started" })),
    });
    const bin = path.join(yield* fileSystem.makeTempDirectoryScoped(), "newgit");
    yield* fileSystem.writeFileString(
      bin,
      [
        "#!/bin/sh",
        `echo "$*" >> '${log}'`,
        'case "$1" in',
        `  remove) [ "$(grep -c '^remove' '${log}')" -ge ${input.removeOkAt} ] && { echo '{"instance":"feature","checkpoint":"ckpt_002","lost":[]}'; exit 0; }`,
        `    echo '${REFUSAL}' >&2; exit 1 ;;`,
        `  start) echo '${started}' ;;`,
        `  stop) echo '{"instance":"feature","resources":[]}' ;;`,
        "esac",
      ].join("\n"),
    );
    yield* fileSystem.chmod(bin, 0o755);
    yield* Effect.acquireRelease(
      Effect.sync(() => swapNewgitBin(bin)),
      (previous) => Effect.sync(() => swapNewgitBin(previous)),
    );
    const calls = fileSystem.readFileString(log).pipe(
      Effect.map((text) => text.trim().split("\n")),
      Effect.orElseSucceed(() => [] as string[]),
    );
    return { dir, workspace: { name: "feature", storeRoot }, calls };
  });

describe("newgit removal", () => {
  it.effect("starts a refused instance so its capture can run, and removes it again", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ removeOkAt: 2, started: ["db"] });
      yield* removeNewgitWorkspace(fixture.workspace, fixture.dir);
      assert.deepEqual(yield* fixture.calls, [
        "remove feature",
        "start feature --json",
        "remove feature",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("yields newgit's refusal when starting brought nothing back", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ removeOkAt: 99, started: [] });
      const error = yield* removeNewgitWorkspace(fixture.workspace, fixture.dir).pipe(Effect.flip);
      assert.equal(error.reason, "newgit_remove_refused");
      assert.equal(error.detail, REFUSAL.slice("Error: ".length));
      assert.deepEqual(yield* fixture.calls, ["remove feature", "start feature --json"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stops what it started when the removal is refused again", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ removeOkAt: 99, started: ["db"] });
      const error = yield* removeNewgitWorkspace(fixture.workspace, fixture.dir).pipe(Effect.flip);
      assert.equal(error.reason, "newgit_remove_refused");
      assert.deepEqual(yield* fixture.calls, [
        "remove feature",
        "start feature --json",
        "remove feature",
        "stop feature --json",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts neither an evicted instance nor a forced removal", () =>
    Effect.gen(function* () {
      const evicted = yield* setup({ removeOkAt: 99, started: ["db"], evicted: true });
      yield* removeNewgitWorkspace(evicted.workspace, evicted.dir).pipe(Effect.flip);
      assert.deepEqual(yield* evicted.calls, ["remove feature"]);

      const forced = yield* setup({ removeOkAt: 99, started: ["db"] });
      const error = yield* removeNewgitWorkspace(forced.workspace, forced.dir, {
        force: true,
      }).pipe(Effect.flip);
      assert.equal(error.reason, "newgit_remove_refused");
      assert.deepEqual(yield* forced.calls, ["remove feature --force"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(!newgitAvailable)(
    "keeps a settled thread's in-workspace state until a start lets its capture run",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
        const project = path.join(root, "project");
        yield* fileSystem.makeDirectory(path.join(project, ".newgit", "resources"), {
          recursive: true,
        });
        const run = (args: ReadonlyArray<string>) => {
          const [command, ...rest] = args;
          const result = NodeChildProcess.spawnSync(command!, rest, {
            cwd: project,
            encoding: "utf8",
          });
          if (result.status !== 0) throw new Error(`${args.join(" ")}: ${result.stderr}`);
        };
        const git = (...args: ReadonlyArray<string>) =>
          run(["git", "-c", "user.name=t3", "-c", "user.email=t3@example.com", ...args]);
        git("init", "-q", "-b", "main");
        yield* fileSystem.writeFileString(path.join(project, ".gitignore"), "/.db/\n");
        git("add", ".gitignore");
        git("commit", "-q", "-m", "init");
        run([newgitBin, "init"]);
        const configPath = path.join(project, ".newgit", "config.toml");
        yield* fileSystem.writeFileString(
          configPath,
          `${yield* fileSystem.readFileString(configPath)}\n[workspace]\nroot = ${JSON.stringify(path.join(root, "workspaces"))}\n`,
        );
        // A database stand-in: its state is in the workspace, and its dump needs it running.
        yield* fileSystem.writeFileString(
          path.join(project, ".newgit", "resources", "db.toml"),
          [
            'ownership = "workspace"',
            "depends_on = []",
            "[actions.prepare]",
            'command = "mkdir -p .db && echo seed > .db/data"',
            "[actions.start]",
            'command = "echo $$ > .db/pid; exec sleep 600"',
            "long_running = true",
            "autostart = true",
            "[checkpoint]",
            'mode = "command"',
            'command = "test ! -e .db/broken && kill -0 $(cat .db/pid) && cat .db/data"',
          ].join("\n"),
        );
        git("add", ".newgit");
        git("commit", "-q", "-m", "db");

        const spawn = (name: string) =>
          driver.createWorktree({ cwd: project, refName: "main", newRefName: name, path: null });

        // Settled: stopped, so the dump fails. The delete starts it, and the second remove keeps it.
        const { worktree: settled } = yield* spawn("t3code/settled");
        yield* stopNewgitInstance(settled.path);
        yield* driver.removeWorktree({ cwd: project, path: settled.path, force: true });
        assert.isFalse(yield* fileSystem.exists(settled.path));

        // A dump that fails even running: nothing is deleted until the user forces it.
        const { worktree: broken } = yield* spawn("t3code/broken");
        yield* fileSystem.writeFileString(path.join(broken.path, ".db", "broken"), "");
        const error = yield* driver
          .removeWorktree({ cwd: project, path: broken.path, force: true })
          .pipe(Effect.flip);
        assert.equal(error.reason, "newgit_remove_refused");
        assert.include(error.detail, "not removing `t3code/broken`");
        assert.equal(
          yield* fileSystem.readFileString(path.join(broken.path, ".db", "data")),
          "seed\n",
        );
        yield* driver.removeWorktree({
          cwd: project,
          path: broken.path,
          force: true,
          newgitForce: true,
        });
        assert.isFalse(yield* fileSystem.exists(broken.path));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          GitVcsDriver.layer.pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-newgit-test-" })),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );
});
