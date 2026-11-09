// newgit fork patch: choosing a new newgit workspace's trackers.
// @effect-diagnostics nodeBuiltinImport:off - sets up a plain git repository synchronously.
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

import { listNewgitTrackers, spawnNewgitWorkspace } from "./newgitWorkspaces.ts";

// Set T3CODE_NEWGIT_BIN (unset for undefined), returning its previous value. The source reads it
// the same way, outside Effect.
const swapNewgitBin = (value: string | undefined) => {
  const previous = process.env.T3CODE_NEWGIT_BIN;
  if (value === undefined) delete process.env.T3CODE_NEWGIT_BIN;
  else process.env.T3CODE_NEWGIT_BIN = value;
  return previous;
};

// Point T3CODE_NEWGIT_BIN at a script standing in for newgit for the scope's lifetime.
const fakeNewgit = (script: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bin = path.join(yield* fileSystem.makeTempDirectoryScoped(), "newgit");
    yield* fileSystem.writeFileString(bin, `#!/bin/sh\n${script}\n`);
    yield* fileSystem.chmod(bin, 0o755);
    yield* Effect.acquireRelease(
      Effect.sync(() => swapNewgitBin(bin)),
      (previous) => Effect.sync(() => swapNewgitBin(previous)),
    );
  });

// A directory that is (or is not) a newgit project root.
const project = (newgit: boolean) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped();
    if (newgit) {
      yield* fileSystem.makeDirectory(path.join(dir, ".newgit"));
      yield* fileSystem.writeFileString(path.join(dir, ".newgit", "config.toml"), "");
    }
    return { dir, log: path.join(dir, "calls.log") };
  });

const LISTED = JSON.stringify({
  instance: null,
  trackers: [
    {
      name: "root",
      parent: null,
      paths: ["."],
      git: true,
      role: null,
      priority: 0,
      requires: [],
      selectable: false,
      default_bound: true,
      bound: null,
    },
    {
      name: "t3code/repos",
      parent: "t3code",
      paths: ["apps/t3code/.repos"],
      git: true,
      role: null,
      priority: -1,
      requires: [],
      selectable: true,
      default_bound: false,
      bound: null,
    },
  ],
});

const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-newgit-trackers-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

describe("newgit trackers", () => {
  it.effect("spawns with the trackers chosen beyond the defaults", () =>
    Effect.gen(function* () {
      const { dir, log } = yield* project(true);
      yield* fakeNewgit(`echo "$*" >> '${log}'; echo '{"workspace":"/tmp/ws/feature"}'`);
      yield* spawnNewgitWorkspace({
        cwd: dir,
        name: "feature",
        from: "main",
        trackers: { use: ["t3code", "t3code/repos"], drop: ["agent-notes"] },
      });
      const fileSystem = yield* FileSystem.FileSystem;
      assert.strictEqual(
        (yield* fileSystem.readFileString(log)).trim(),
        "spawn feature --from main --use t3code --use t3code/repos --drop agent-notes --json",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lists a newgit project's trackers with their defaults", () =>
    Effect.gen(function* () {
      const { dir, log } = yield* project(true);
      yield* fakeNewgit(`echo "$*" >> '${log}'; echo '${LISTED}'`);
      const trackers = yield* listNewgitTrackers(dir);
      assert.deepEqual(trackers, [
        {
          name: "root",
          parent: null,
          paths: ["."],
          git: true,
          role: null,
          priority: 0,
          requires: [],
          selectable: false,
          defaultBound: true,
        },
        {
          name: "t3code/repos",
          parent: "t3code",
          paths: ["apps/t3code/.repos"],
          git: true,
          role: null,
          priority: -1,
          requires: [],
          selectable: true,
          defaultBound: false,
        },
      ]);
      const fileSystem = yield* FileSystem.FileSystem;
      assert.strictEqual((yield* fileSystem.readFileString(log)).trim(), "tracker list --json");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("offers no choice outside a newgit project, or when newgit cannot list", () =>
    Effect.gen(function* () {
      yield* fakeNewgit(`echo '${LISTED}'`);
      assert.isNull(yield* listNewgitTrackers((yield* project(false)).dir));
      // An older newgit, without `tracker list --json`.
      yield* fakeNewgit("echo \"error: unexpected argument '--json' found\" >&2; exit 2");
      assert.isNull(yield* listNewgitTrackers((yield* project(true)).dir));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a tracker choice a plain worktree cannot honor", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const { dir } = yield* project(false);
      const git = (...args: string[]) =>
        NodeChildProcess.execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
      git("init", "-q", "-b", "main");
      git(
        "-c",
        "user.name=t3",
        "-c",
        "user.email=t3@example.com",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      );
      const error = yield* driver
        .createWorktree({
          cwd: dir,
          refName: "main",
          newRefName: "t3code/abcd1234",
          path: null,
          newgitTrackers: { use: ["t3code"], drop: [] },
        })
        .pipe(Effect.flip);
      assert.include(error.detail, "would not be a newgit workspace");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
