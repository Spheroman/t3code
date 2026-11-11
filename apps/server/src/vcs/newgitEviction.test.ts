// newgit fork patch: a settled thread's workspace is evicted (`newgit stop --evict`), and the
// next `newgit start` brings it back. newgit refuses an eviction that would lose something.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import {
  newgitWorkspaceIdle,
  releaseIdleProviderSessions,
} from "../orchestration-v2/ThreadSettlementService.ts";
import {
  evictNewgitInstance,
  isEvictedNewgitWorkspace,
  startNewgitInstance,
} from "./newgitWorkspaces.ts";

const swapNewgitBin = (value: string | undefined) => {
  const previous = process.env.T3CODE_NEWGIT_BIN;
  if (value === undefined) delete process.env.T3CODE_NEWGIT_BIN;
  else process.env.T3CODE_NEWGIT_BIN = value;
  return previous;
};

// A workspace marker for `feature` whose project root is elsewhere, and a fake newgit that logs
// its cwd and arguments, then runs `body`.
const setup = (body: string) =>
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
    const log = path.join(storeRoot, "calls.log");
    const bin = path.join(yield* fileSystem.makeTempDirectoryScoped(), "newgit");
    yield* fileSystem.writeFileString(
      bin,
      `#!/bin/sh\necho "$(pwd -P): $*" >> '${log}'\n${body}\n`,
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
    return { dir, storeRoot, calls };
  });

const captureLogs = () => {
  const logs: Array<{ readonly level: string; readonly text: string }> = [];
  const logger = Logger.make(({ message, logLevel }) =>
    logs.push({ level: logLevel, text: JSON.stringify(message) }),
  );
  return { logs, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

describe("newgit eviction", () => {
  it.effect("evicts from the project root, naming the instance, and reads its report", () => {
    const captured = captureLogs();
    return Effect.gen(function* () {
      const report = JSON.stringify({
        instance: "feature",
        resources: [],
        evicted: {
          checkpoint: "ckpt_004",
          discarded: [],
          not_kept: ["intent-to-add entries"],
        },
      });
      const workspace = yield* setup(`echo '${report}'`);
      yield* evictNewgitInstance(workspace.dir, Effect.succeed(true));
      assert.deepEqual(yield* workspace.calls, [
        `${workspace.storeRoot}: stop feature --evict --json`,
      ]);
      assert.deepEqual(
        captured.logs.map((log) => log.level),
        ["Info"],
      );
      assert.include(captured.logs[0]!.text, "newgit evicted a settled thread's workspace");
      assert.include(captured.logs[0]!.text, "intent-to-add entries");
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(captured.layer, NodeServices.layer)));
  });

  it.effect("skips an eviction the thread no longer wants", () =>
    Effect.gen(function* () {
      const workspace = yield* setup(`echo '{"resources":[]}'`);
      yield* evictNewgitInstance(workspace.dir, Effect.succeed(false));
      assert.deepEqual(yield* workspace.calls, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("logs newgit's refusal as information and leaves the workspace", () => {
    const captured = captureLogs();
    return Effect.gen(function* () {
      const workspace = yield* setup(
        "echo '[newgit] warning: stopping' >&2\n" +
          "echo 'Error: not evicting `feature`: ignored files nothing rebuilds: target/ (20000 files)' >&2\n" +
          "exit 1",
      );
      yield* evictNewgitInstance(workspace.dir, Effect.succeed(true));
      assert.deepEqual(yield* workspace.calls, [
        `${workspace.storeRoot}: stop feature --evict --json`,
      ]);
      assert.deepEqual(
        captured.logs.map((log) => log.level),
        ["Info"],
      );
      assert.include(captured.logs[0]!.text, "newgit kept a settled thread's workspace on disk");
      assert.include(
        captured.logs[0]!.text,
        "not evicting `feature`: ignored files nothing rebuilds: target/ (20000 files)",
      );
      assert.isTrue(yield* isEvictedNewgitWorkspace(workspace.dir));
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(captured.layer, NodeServices.layer)));
  });

  it.effect("logs an unreadable report instead of failing", () =>
    Effect.gen(function* () {
      const workspace = yield* setup("echo 'not json'");
      yield* evictNewgitInstance(workspace.dir, Effect.succeed(true));
      assert.deepEqual(yield* workspace.calls, [
        `${workspace.storeRoot}: stop feature --evict --json`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("yields newgit's warnings and error when `newgit start` could not restore", () =>
    Effect.gen(function* () {
      const longCause = "x".repeat(5000);
      const workspace = yield* setup(
        "echo '[newgit] warning: kept what was at the path in /w/.feature.restore-failed; no checkpoint holds it' >&2\n" +
          "echo '[newgit] warning: discard it with: newgit cleanup --discard-saved /w/.feature.restore-failed' >&2\n" +
          "echo 'restoring from ckpt_004, Error: is not the cause' >&2\n" +
          `echo 'Error: restoring \`feature\` failed: ${longCause}' >&2\n` +
          "echo 'Caused by: disk full' >&2\nexit 1",
      );
      const { failure } = yield* startNewgitInstance(workspace.dir);
      const lines = failure?.split("\n") ?? [];
      assert.deepEqual(lines.slice(0, 2), [
        "kept what was at the path in /w/.feature.restore-failed; no checkpoint holds it",
        "discard it with: newgit cleanup --discard-saved /w/.feature.restore-failed",
      ]);
      assert.isTrue(lines[2]!.startsWith("restoring `feature` failed: xxx"));
      assert.isBelow(failure!.length, 3000);

      const started = yield* setup(
        `echo '{"resources":[],"restored":{"checkpoint":"ckpt_004"},"warnings":["saved copy at /w/.feature.restore-failed"]}'`,
      );
      assert.deepEqual(yield* startNewgitInstance(started.dir), {
        failure: null,
        warnings: ["saved copy at /w/.feature.restore-failed"],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("runs no `newgit start` after a failed restore until the user acts again", () =>
    Effect.gen(function* () {
      const workspace = yield* setup("echo 'Error: restoring `feature` failed' >&2\nexit 1");
      const failed = { failure: "restoring `feature` failed", warnings: [] };
      assert.deepEqual(yield* startNewgitInstance(workspace.dir), failed);
      // Automatic starts (unsettling, a retry), and a message sent before the failure, wait.
      assert.deepEqual(yield* startNewgitInstance(workspace.dir), failed);
      assert.deepEqual(yield* startNewgitInstance(workspace.dir, { userActedAt: 0 }), failed);
      assert.lengthOf(yield* workspace.calls, 1);

      yield* TestClock.adjust(Duration.seconds(5));
      assert.deepEqual(yield* startNewgitInstance(workspace.dir, { userActedAt: 1000 }), failed);
      assert.lengthOf(yield* workspace.calls, 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("tells an evicted workspace, holding only its marker, from a present one", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* setup(`echo '{"resources":[]}'`);
      assert.isTrue(yield* isEvictedNewgitWorkspace(workspace.dir));
      yield* fileSystem.makeDirectory(path.join(workspace.dir, ".git"));
      assert.isFalse(yield* isEvictedNewgitWorkspace(workspace.dir));
      const plain = yield* fileSystem.makeTempDirectoryScoped();
      assert.isFalse(yield* isEvictedNewgitWorkspace(plain));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("releaseIdleProviderSessions", () => {
  const parent = ThreadId.make("parent");
  const child = ThreadId.make("child");
  const release = (input: {
    readonly live: ReadonlyArray<string>;
    readonly sharedWithOthers?: ReadonlyArray<string>;
    readonly unfinished?: ReadonlyArray<string>;
  }) => {
    const released: string[] = [];
    const sessionsByThread: Record<string, ReadonlyArray<string | null>> = {
      parent: ["session-parent", "session-parent", null],
      child: ["session-child", "session-shared"],
    };
    return releaseIdleProviderSessions(
      {
        getThreadRecords: (threadId) =>
          Effect.succeed({
            providerThreads: (sessionsByThread[threadId] ?? []).map((providerSessionId) => ({
              providerSessionId,
            })),
          } as never),
      },
      {
        isLive: (providerSessionId) => Effect.succeed(input.live.includes(providerSessionId)),
        otherWorkingThreads: ({ providerSessionId }) =>
          Effect.succeed(
            input.sharedWithOthers?.includes(providerSessionId) ? [ThreadId.make("other")] : [],
          ),
        hasUnfinishedWork: (providerSessionId) =>
          Effect.succeed(input.unfinished?.includes(providerSessionId) ?? false),
        releaseUnlessBusy: ({ providerSessionId, ownProviderThreadIds, keepIfUnfinishedWork }) => {
          assert.deepEqual(ownProviderThreadIds, []);
          assert.isTrue(keepIfUnfinishedWork);
          released.push(providerSessionId);
          return Effect.succeed(true);
        },
      },
      [parent, child],
    ).pipe(Effect.as(released));
  };

  it.effect("releases each live session the workspace's threads hold alone, once", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* release({
          live: ["session-parent", "session-child", "session-shared"],
          sharedWithOthers: ["session-shared"],
        }),
        ["session-parent", "session-child"],
      );
      assert.deepEqual(yield* release({ live: [] }), []);
    }),
  );

  it.effect("releases none while any of them still has work", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* release({
          live: ["session-parent", "session-child"],
          unfinished: ["session-child"],
        }),
        [],
      );
    }),
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
