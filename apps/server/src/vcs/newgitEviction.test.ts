// newgit fork patch: a settled thread's workspace is evicted (`newgit stop --evict`), and the
// next `newgit start` brings it back.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { newgitWorkspaceIdle } from "../orchestration-v2/ThreadSettlementService.ts";
import { evictNewgitInstance, isEvictedNewgitWorkspace } from "./newgitWorkspaces.ts";

const swapNewgitBin = (value: string | undefined) => {
  const previous = process.env.T3CODE_NEWGIT_BIN;
  if (value === undefined) delete process.env.T3CODE_NEWGIT_BIN;
  else process.env.T3CODE_NEWGIT_BIN = value;
  return previous;
};

// A workspace marker for `feature`, and a fake newgit that logs its arguments and prints `report`.
const setup = (report: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped();
    yield* fileSystem.makeDirectory(path.join(dir, ".newgit", "local"), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(dir, ".newgit", "local", "instance.toml"),
      `branch = "feature"\nstore_root = "${dir}"\n`,
    );
    const log = path.join(dir, "calls.log");
    const bin = path.join(yield* fileSystem.makeTempDirectoryScoped(), "newgit");
    yield* fileSystem.writeFileString(bin, `#!/bin/sh\necho "$*" >> '${log}'\necho '${report}'\n`);
    yield* fileSystem.chmod(bin, 0o755);
    yield* Effect.acquireRelease(
      Effect.sync(() => swapNewgitBin(bin)),
      (previous) => Effect.sync(() => swapNewgitBin(previous)),
    );
    const calls = fileSystem.readFileString(log).pipe(
      Effect.map((text) => text.trim().split("\n")),
      Effect.orElseSucceed(() => [] as string[]),
    );
    return { dir, calls };
  });

describe("newgit eviction", () => {
  it.effect("evicts with `stop --evict` and reads its report", () =>
    Effect.gen(function* () {
      const workspace = yield* setup(
        '{"instance":"feature","resources":[],"evicted":{"checkpoint":"ckpt_004","discarded":["target"]}}',
      );
      yield* evictNewgitInstance(workspace.dir, Effect.succeed(true));
      assert.deepEqual(yield* workspace.calls, ["stop feature --evict --json"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("skips an eviction the thread no longer wants", () =>
    Effect.gen(function* () {
      const workspace = yield* setup('{"resources":[]}');
      yield* evictNewgitInstance(workspace.dir, Effect.succeed(false));
      assert.deepEqual(yield* workspace.calls, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("logs a failed eviction instead of failing", () =>
    Effect.gen(function* () {
      const workspace = yield* setup("not json");
      yield* evictNewgitInstance(workspace.dir, Effect.succeed(true));
      assert.deepEqual(yield* workspace.calls, ["stop feature --evict --json"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("tells an evicted workspace, holding only its marker, from a present one", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* setup('{"resources":[]}');
      assert.isTrue(yield* isEvictedNewgitWorkspace(workspace.dir));
      yield* fileSystem.makeDirectory(path.join(workspace.dir, ".git"));
      assert.isFalse(yield* isEvictedNewgitWorkspace(workspace.dir));
      const plain = yield* fileSystem.makeTempDirectoryScoped();
      assert.isFalse(yield* isEvictedNewgitWorkspace(plain));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("newgitWorkspaceIdle", () => {
  const parent = ThreadId.make("parent");
  const child = ThreadId.make("child");
  const elsewhere = ThreadId.make("elsewhere");
  const idle = (input: {
    readonly settled: ReadonlyArray<ThreadId>;
    readonly running?: ReadonlyArray<ThreadId>;
  }) =>
    newgitWorkspaceIdle(
      {
        getThreadWorktreePaths: () =>
          Effect.succeed([
            { threadId: parent, worktreePath: "/w/feature" },
            { threadId: child, worktreePath: "/w/feature" },
            { threadId: elsewhere, worktreePath: "/w/other" },
          ]),
        getThread: (threadId) =>
          Effect.succeed({
            id: threadId,
            settledOverride: input.settled.includes(threadId) ? "settled" : null,
          } as never),
      },
      {
        threadHasRunningSessions: ({ threadId }) =>
          Effect.succeed(input.running?.includes(threadId as ThreadId) ?? false),
      },
      parent,
      "/w/feature",
    );

  it.effect("evicts once every thread in the workspace is settled and idle", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* idle({ settled: [parent, child] }));
    }),
  );

  it.effect("keeps a workspace a delegated child still works in", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* idle({ settled: [parent] }));
      assert.isFalse(yield* idle({ settled: [parent, child], running: [child] }));
    }),
  );

  it.effect("keeps a workspace whose own thread was unsettled or runs a terminal", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* idle({ settled: [child] }));
      assert.isFalse(yield* idle({ settled: [parent, child], running: [parent] }));
    }),
  );
});
