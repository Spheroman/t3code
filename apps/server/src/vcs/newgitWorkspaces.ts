/**
 * newgit fork patch: in a project with `.newgit/config.toml`, worktrees become newgit workspaces.
 * Upstream files only carry small hooks into this module, so the fork rebases cleanly.
 * `T3CODE_NEWGIT=0` opts out; `T3CODE_NEWGIT_BIN` names a binary off the server's PATH.
 */
import { GitCommandError, type NewgitTracker, type NewgitTrackerChoice } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";

// Spawning runs resource `prepare` hooks (dependency installs), so allow far
// longer than a plain `git worktree add`.
const SPAWN_TIMEOUT = Duration.minutes(15);
const REMOVE_TIMEOUT = Duration.minutes(5);
const LIFECYCLE_TIMEOUT = Duration.minutes(5);
const LIST_TIMEOUT = Duration.seconds(30);

// The fields of `spawn --json` this module reads; newgit reports more.
const SpawnResource = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  blocked_by: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  prepare_log: Schema.optional(Schema.NullOr(Schema.String)),
  render_error: Schema.optional(Schema.NullOr(Schema.String)),
  export_error: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeSpawnOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      workspace: Schema.NonEmptyString,
      resources: Schema.optional(Schema.Array(SpawnResource)),
    }),
  ),
);
const isSpawnError = Schema.is(ProcessRunner.ProcessSpawnError);
const isGitCommandError = Schema.is(GitCommandError);

export interface NewgitWorkspace {
  /** The instance name, which is also its source branch. */
  readonly name: string;
  /** The project root that owns the instance's store. */
  readonly storeRoot: string;
}

const newgitBinary = () => process.env.T3CODE_NEWGIT_BIN?.trim() || "newgit";

const enabled = () => process.env.T3CODE_NEWGIT !== "0";

/** Whether `cwd` is the root of a newgit project, so worktrees should be newgit workspaces. */
export const projectUsesNewgit = Effect.fn("newgitWorkspaces.projectUsesNewgit")(function* (
  cwd: string,
) {
  if (!enabled()) return false;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem
    .exists(path.join(cwd, ".newgit", "config.toml"))
    .pipe(Effect.orElseSucceed(() => false));
});

// The marker is two `key = "value"` lines written by newgit; a TOML parser is overkill.
const parseMarker = (contents: string): NewgitWorkspace | null => {
  const fields = new Map<string, string>();
  for (const line of contents.split("\n")) {
    const match = /^\s*(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
    if (match) fields.set(match[1]!, match[2]!.replace(/\\(.)/g, "$1"));
  }
  const name = fields.get("branch");
  const storeRoot = fields.get("store_root");
  return name && storeRoot ? { name, storeRoot } : null;
};

/** The newgit instance whose workspace is `workspacePath`, if it is one. */
export const readNewgitWorkspace = Effect.fn("newgitWorkspaces.readNewgitWorkspace")(function* (
  workspacePath: string,
) {
  if (!enabled()) return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem
    .readFileString(path.join(workspacePath, ".newgit", "local", "instance.toml"))
    .pipe(
      Effect.map(parseMarker),
      Effect.orElseSucceed(() => null),
    );
});

interface NewgitOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const runNewgit = Effect.fn("newgitWorkspaces.runNewgit")(function* (input: {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly timeout: Duration.Duration;
  /** Exit codes after which stdout is still the command's report, besides 0. */
  readonly reportExitCodes?: ReadonlyArray<number>;
}) {
  const runner = yield* ProcessRunner.make();
  const command = `newgit ${input.args[0] ?? ""}`.trim();
  const fail = (detail: string, extra: { exitCode?: number; cause?: unknown } = {}) =>
    new GitCommandError({ operation: input.operation, command, cwd: input.cwd, detail, ...extra });
  const result = yield* runner
    .run({
      command: newgitBinary(),
      args: input.args,
      cwd: input.cwd,
      timeout: input.timeout,
    })
    .pipe(
      Effect.mapError((cause) => fail(`${command} could not run: ${cause.message}`, { cause })),
    );
  if (result.timedOut) return yield* fail(`${command} timed out`);
  const exitCode = result.code === null ? null : Number(result.code);
  if (exitCode === null || (exitCode !== 0 && !input.reportExitCodes?.includes(exitCode))) {
    return yield* fail(
      result.stderr.trim() || `${command} failed`,
      exitCode === null ? {} : { exitCode },
    );
  }
  const output: NewgitOutput = { stdout: result.stdout, stderr: result.stderr, exitCode };
  return output;
});

const describeResource = (resource: typeof SpawnResource.Type) => {
  const reason =
    resource.render_error ??
    resource.export_error ??
    (resource.blocked_by?.length ? `blocked by ${resource.blocked_by.join(", ")}` : null) ??
    (resource.prepare_log ? `see ${resource.prepare_log}` : null);
  return reason
    ? `${resource.name} (${resource.status}): ${reason}`
    : `${resource.name} (${resource.status})`;
};

const decodeTrackerList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      trackers: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          parent: Schema.NullOr(Schema.String),
          paths: Schema.Array(Schema.String),
          git: Schema.Boolean,
          role: Schema.NullOr(Schema.String),
          priority: Schema.Number,
          requires: Schema.Array(Schema.String),
          selectable: Schema.Boolean,
          default_bound: Schema.NullOr(Schema.Boolean),
        }),
      ),
    }),
  ),
);

/**
 * `newgit tracker list --json` in the project at `cwd`: what a new workspace may bind,
 * and what it binds by default. Null outside a newgit project, or when newgit can't run
 * (an older newgit without `--json` included): the caller offers no choice then.
 */
export const listNewgitTrackers = Effect.fn("newgitWorkspaces.listNewgitTrackers")(function* (
  cwd: string,
) {
  if (!(yield* projectUsesNewgit(cwd))) return null;
  const listed = yield* runNewgit({
    operation: "newgitWorkspaces.listTrackers",
    cwd,
    args: ["tracker", "list", "--json"],
    timeout: LIST_TIMEOUT,
  }).pipe(
    Effect.flatMap((output) => decodeTrackerList(output.stdout)),
    Effect.map(({ trackers }) =>
      trackers.map((tracker): NewgitTracker => ({
        name: tracker.name,
        parent: tracker.parent,
        paths: tracker.paths,
        git: tracker.git,
        role: tracker.role,
        priority: tracker.priority,
        requires: tracker.requires,
        selectable: tracker.selectable,
        defaultBound: tracker.default_bound,
      })),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("newgit tracker list failed; offering no tracker choice", {
        cwd,
        cause,
      }).pipe(Effect.as(null)),
    ),
  );
  return listed;
});

const trackerArgs = (choice: NewgitTrackerChoice | undefined) => [
  ...(choice?.use ?? []).flatMap((tracker) => ["--use", tracker]),
  ...(choice?.drop ?? []).flatMap((tracker) => ["--drop", tracker]),
];

/**
 * `newgit spawn <name> --from <ref>` in the project at `cwd`. Returns the workspace
 * path, or None when newgit can't run so the caller falls back to a git worktree.
 * Exit 1 with a report means a resource didn't come up: open the workspace anyway.
 */
export const spawnNewgitWorkspace = Effect.fn("newgitWorkspaces.spawnNewgitWorkspace")(
  function* (input: {
    readonly cwd: string;
    readonly name: string;
    readonly from: string;
    readonly trackers?: NewgitTrackerChoice | undefined;
  }) {
    const output = yield* runNewgit({
      operation: "newgitWorkspaces.spawn",
      cwd: input.cwd,
      args: ["spawn", input.name, "--from", input.from, ...trackerArgs(input.trackers), "--json"],
      timeout: SPAWN_TIMEOUT,
      reportExitCodes: [1],
    }).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => isSpawnError(error.cause),
        (error) =>
          Effect.logWarning("newgit is not runnable; using a git worktree instead", {
            cwd: input.cwd,
            detail: error.detail,
          }).pipe(Effect.as(Option.none<NewgitOutput>())),
      ),
    );
    if (Option.isNone(output)) return Option.none<string>();
    const { stdout, stderr, exitCode } = output.value;
    const { workspace, resources = [] } = yield* decodeSpawnOutput(stdout).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "newgitWorkspaces.spawn",
            command: "newgit spawn",
            cwd: input.cwd,
            detail:
              exitCode === 0
                ? "newgit spawn did not report a workspace path"
                : stderr.trim() || "newgit spawn failed",
            ...(exitCode === 0 ? {} : { exitCode }),
            cause,
          }),
      ),
    );
    const notReady = resources.filter((resource) => resource.status !== "ready");
    if (exitCode !== 0 || notReady.length > 0) {
      yield* Effect.logWarning("newgit spawned the workspace, but some resources are not ready", {
        workspace,
        resources: notReady.map(describeResource),
      });
    }
    return Option.some(workspace);
  },
);

/** `newgit remove <name>`, run from the instance's project root. */
export const removeNewgitWorkspace = (workspace: NewgitWorkspace) =>
  runNewgit({
    operation: "newgitWorkspaces.remove",
    cwd: workspace.storeRoot,
    args: ["remove", workspace.name],
    timeout: REMOVE_TIMEOUT,
  }).pipe(Effect.asVoid);

const decodeLifecycleOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      resources: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          status: Schema.String,
          error: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
      warnings: Schema.optional(Schema.Array(Schema.String)),
      evicted: Schema.optional(
        Schema.Struct({
          checkpoint: Schema.String,
          discarded: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String }))),
          not_kept: Schema.optional(Schema.Array(Schema.String)),
          already: Schema.optional(Schema.Boolean),
        }),
      ),
      restored: Schema.optional(Schema.Struct({ checkpoint: Schema.String })),
    }),
  ),
);

// One permit per instance, so a turn's `start` waits out a settle's `stop` still running.
const instanceLocks = new Map<string, Semaphore.Semaphore>();
const instanceKey = (workspace: NewgitWorkspace) => `${workspace.storeRoot}\0${workspace.name}`;
const instanceLock = (workspace: NewgitWorkspace) => {
  const key = instanceKey(workspace);
  let lock = instanceLocks.get(key);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    instanceLocks.set(key, lock);
  }
  return lock;
};

const lifecycleArgs = (verb: "stop" | "evict" | "start", name: string) =>
  verb === "evict" ? ["stop", name, "--evict", "--json"] : [verb, name, "--json"];

const WARNING_PREFIX = "[newgit] warning: ";
const ERROR_PREFIX = "Error: ";
const MAX_REASON_LINE = 600;
const MAX_REASON_WARNINGS = 12;
const MAX_REASON_ERROR = 2000;

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/**
 * A command newgit refused exits 1 with no report. Its stderr holds `[newgit] warning:` lines,
 * such as where a failed restore kept what was at the path, then `Error: <why>` last. The reason
 * is those warnings, then the error, each line clipped on its own so no warning is lost to a
 * long error.
 */
const newgitError = (stderr: string) => {
  const lines = stderr.split(/\r?\n/);
  const errorAt = lines.findLastIndex((line) => line.startsWith(ERROR_PREFIX));
  const warnings = (errorAt === -1 ? lines : lines.slice(0, errorAt))
    .filter((line) => line.startsWith(WARNING_PREFIX))
    .map((line) => clip(line.slice(WARNING_PREFIX.length).trim(), MAX_REASON_LINE))
    .filter((line) => line !== "");
  const error =
    errorAt === -1
      ? warnings.length > 0
        ? ""
        : stderr.trim()
      : lines.slice(errorAt).join("\n").slice(ERROR_PREFIX.length).trim();
  return [
    ...warnings.slice(0, MAX_REASON_WARNINGS),
    ...(warnings.length > MAX_REASON_WARNINGS
      ? [`(${warnings.length - MAX_REASON_WARNINGS} more warnings)`]
      : []),
    ...(error === "" ? [] : [clip(error, MAX_REASON_ERROR)]),
  ].join("\n");
};

interface LifecycleOutcome {
  /** Why newgit did not do it, or null. */
  readonly failure: string | null;
  /** What a successful run warned, such as saved copies a failed restore left. */
  readonly warnings: ReadonlyArray<string>;
}
const succeeded = (warnings: ReadonlyArray<string> = []): LifecycleOutcome => ({
  failure: null,
  warnings,
});

/**
 * Each failed restore moves what is at the path aside into another full saved copy, so after one
 * fails nothing restores that workspace again until someone acts. Keyed like `instanceLocks`.
 */
const restoreFailures = new Map<string, { readonly reason: string; readonly atMs: number }>();

/**
 * `newgit stop|start <name>` (or `stop --evict`), run from the project root so our cwd is never
 * in the workspace; a no-op outside one. Never fails. `stillWanted` is checked under the instance
 * lock. A start may restore a workspace: spawn's time. A start with a restore failed since
 * `userActedAt` (always, when absent) does not run and yields that failure.
 */
const runLifecycle = Effect.fn("newgitWorkspaces.runLifecycle")(
  function* (
    verb: "stop" | "evict" | "start",
    worktreePath: string,
    stillWanted: Effect.Effect<boolean>,
    userActedAt?: number,
  ) {
    const workspace = yield* readNewgitWorkspace(worktreePath);
    if (workspace === null) return succeeded();
    const key = instanceKey(workspace);
    return yield* instanceLock(workspace).withPermits(1)(
      Effect.gen(function* () {
        if (!(yield* stillWanted)) return succeeded();
        let restoring = false;
        if (verb === "start") {
          const failed = restoreFailures.get(key);
          if (failed !== undefined) {
            if (userActedAt === undefined || userActedAt <= failed.atMs) {
              return { failure: failed.reason, warnings: [] } satisfies LifecycleOutcome;
            }
            restoreFailures.delete(key);
          }
          restoring = yield* isEvictedNewgitWorkspace(worktreePath);
        }
        const { stdout, stderr, exitCode } = yield* runNewgit({
          operation: `newgitWorkspaces.${verb}`,
          cwd: workspace.storeRoot,
          args: lifecycleArgs(verb, workspace.name),
          timeout: verb === "stop" ? LIFECYCLE_TIMEOUT : SPAWN_TIMEOUT,
          reportExitCodes: [1],
        });
        if (exitCode !== 0 && stdout.trim() === "") {
          const reason = newgitError(stderr) || `newgit ${verb} failed`;
          // Refusing is how eviction keeps what would not come back; the workspace stays as it was.
          if (verb === "evict") {
            yield* Effect.logInfo("newgit kept a settled thread's workspace on disk", {
              instance: workspace.name,
              reason,
            });
          } else {
            yield* Effect.logWarning(`newgit ${verb} failed`, { instance: workspace.name, reason });
          }
          if (restoring) {
            restoreFailures.set(key, { reason, atMs: yield* Clock.currentTimeMillis });
          }
          return { failure: reason, warnings: [] } satisfies LifecycleOutcome;
        }
        const {
          resources,
          warnings = [],
          evicted,
          restored,
        } = yield* decodeLifecycleOutput(stdout);
        const failed = resources.filter((resource) => resource.status === "failed");
        if (exitCode !== 0 || failed.length > 0) {
          yield* Effect.logWarning(`newgit ${verb} left some resources behind`, {
            instance: workspace.name,
            resources: failed.map((resource) => `${resource.name}: ${resource.error ?? "failed"}`),
          });
        }
        if (warnings.length > 0) {
          yield* Effect.logWarning(`newgit ${verb} warned`, { instance: workspace.name, warnings });
        }
        if (evicted !== undefined && evicted.already !== true) {
          yield* Effect.logInfo("newgit evicted a settled thread's workspace", {
            instance: workspace.name,
            checkpoint: evicted.checkpoint,
            discarded: (evicted.discarded ?? []).map((discarded) => discarded.path),
            notKept: evicted.not_kept ?? [],
          });
        }
        if (restored !== undefined) {
          yield* Effect.logInfo("newgit restored an evicted workspace", {
            instance: workspace.name,
            checkpoint: restored.checkpoint,
          });
        }
        return succeeded(warnings);
      }),
    );
  },
  (effect, verb, worktreePath) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`newgit ${verb} failed`, { worktreePath, cause }).pipe(
          Effect.as<LifecycleOutcome>({
            failure: Option.match(Cause.findErrorOption(cause), {
              onNone: () => `newgit ${verb} failed`,
              onSome: (error) =>
                isGitCommandError(error) ? error.detail : `newgit ${verb} failed`,
            }),
            warnings: [],
          }),
        ),
      ),
    ),
);

/** Release a settled thread's resources, keeping its workspace. */
export const stopNewgitInstance = (
  worktreePath: string,
  stillSettled: Effect.Effect<boolean> = Effect.succeed(true),
) => runLifecycle("stop", worktreePath, stillSettled).pipe(Effect.asVoid);

/**
 * Checkpoint a settled thread's instance and delete its workspace but its marker. newgit refuses,
 * deleting nothing, when something would not come back; that is logged and the workspace stays.
 * Never `--discard-ignored`: projects declare disposable build output as a newgit resource.
 */
export const evictNewgitInstance = (worktreePath: string, stillWanted: Effect.Effect<boolean>) =>
  runLifecycle("evict", worktreePath, stillWanted).pipe(Effect.asVoid);

/**
 * Bring back what the last `stopNewgitInstance` released, and an evicted workspace first;
 * cheap when nothing was. Yields why newgit could not, and what it warned when it could.
 * Once a restore fails, no start runs for that workspace again until one passes a
 * `userActedAt` (epoch ms) later than the failure: a message the user sent after it.
 */
export const startNewgitInstance = (
  worktreePath: string,
  options: { readonly userActedAt?: number | undefined } = {},
) => runLifecycle("start", worktreePath, Effect.succeed(true), options.userActedAt);

/** Whether `worktreePath` is a newgit workspace that is still evicted: its marker, but no clone. */
export const isEvictedNewgitWorkspace = Effect.fn("newgitWorkspaces.isEvictedNewgitWorkspace")(
  function* (worktreePath: string) {
    if ((yield* readNewgitWorkspace(worktreePath)) === null) return false;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return !(yield* fileSystem
      .exists(path.join(worktreePath, ".git"))
      .pipe(Effect.orElseSucceed(() => true)));
  },
);

/** Provide what this module needs from services a caller already holds. */
export const provideNewgitServices =
  (services: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, services.fileSystem),
      Effect.provideService(Path.Path, services.path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, services.spawner),
    );
