// newgit fork patch: a settled thread's workspace is evicted (`newgit stop --evict`), and the
// next `newgit start` brings it back.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { evictNewgitInstance } from "./newgitWorkspaces.ts";

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
});
