# T3 Code, newgit fork

This fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) adds
[newgit](https://github.com/Spheroman/newgit) support. In a project with
`.newgit/config.toml` at its root, "New worktree" creates a newgit instance
instead of a Git worktree: `newgit spawn <branch> --from <base> --json`
makes the branch, its workspace, and its bound trackers and resources.
Below the base branch, the new-thread panel lists the project's trackers
(`newgit tracker list --json`), set as a spawn binds them by default: a
checkbox per tracker, and one dropdown per role (one of its trackers, or
none). Each change adds `--use` or `--drop` to that spawn. Agents choose the
same way with `newgitTrackers: { use, drop }` on `t3_thread_launch`'s
worktree strategy, `delegate_task` (with `isolation: "worktree"`), and
`t3_worktree_handoff`; `t3 thread start --worktree <base>` takes `--use` and
`--drop`. A choice that would land in a plain Git worktree is refused.
Settling the thread runs `newgit stop`, which releases its running
resources at once. Once the thread's settle action is done, it also runs
`newgit stop --evict`, but only if that thread and every unarchived thread
sharing its workspace, such as a delegated child, are settled and run no
terminal. It first releases those threads' idle provider sessions, whose
`claude` or `codex` process works in the workspace, and runs newgit from the
project root, naming the instance, since newgit refuses to delete a directory
a process works in. A session that still has work, such as a background
command or subagent, an approval, or a question (a thread settled by hand
can), is not released, nor is any other: its process keeps the workspace, and
newgit refuses. That checkpoints the instance and deletes the workspace,
leaving its marker. When the workspace holds what would not come back
(ignored files nothing rebuilds, such as an undeclared `target/`, a rebase in
progress, a shell still in it), newgit refuses and deletes nothing: the
server logs its reason and the workspace stays, stopped. It never passes
`--discard-ignored`; declare build output as a newgit resource instead.
Unsettling the thread runs `newgit start`, and so does every turn before the
agent starts. `start` first brings an evicted workspace back from its
checkpoint, at the same path; if it can't, the turn fails before the agent
starts with newgit's reason, including where it kept what was at the path,
rather than running it in an empty folder. Each failed restore keeps another
full copy, so after one fails the server runs no `start` for that workspace
until the user sends a message; unsettling and retries wait. A workspace
deleted by hand comes back the same way on the thread's next turn: `start`
rebuilds it from the instance's latest checkpoint. A spawn or `start` that
leaves the instance not ready (a `[ready]` check still failing after its
timeout, a port another process holds, a definition problem) exits 1 with
its report: that is not a failure, so the thread opens in the workspace and
the turn runs. newgit's `problems`, and what a `start` warns, such as that a
saved copy is still there, are shown once in the thread, not on every turn.
Eviction is on by default: turn off **Free disk when a newgit
thread settles** in Settings → Threads to keep settled workspaces on disk.
Deleting the thread and its workspace runs `newgit remove` before the
thread is deleted. newgit refuses, deleting nothing, when that would lose
what no checkpoint holds, most often a database kept in the workspace
(`ownership = "workspace"`, the `postgres` template) whose dump cannot run
because settling stopped it. The server then runs `newgit start` and removes
again, if that start brought anything back; if newgit refuses again, it stops
what it started and the user sees newgit's reason, choosing to delete
anyway (`newgit remove --force`) or to keep the thread and its workspace as
they were. A plain worktree is still removed after its thread, as upstream
does. A new
thread that starts from origin waits up to five minutes for its base
branch to fetch, instead of 30 seconds, since a newgit remote can be slow. Every other project gets plain worktrees, as upstream does.

## Branches

- `main` mirrors upstream.
- `newgit` (default) is upstream plus the fork's changes:
  1. newgit workspaces in place of worktrees (server only)
  2. a desktop identity that installs beside upstream T3 Code
  3. fixes to that identity

  It is also the `t3code` tracker in [newgit](https://github.com/Spheroman/newgit),
  mounted at `apps/t3code`, so it only moves forward: upstream comes in by
  merging, never by rebasing, and nothing is force-pushed.

## Install (macOS)

```sh
git clone https://github.com/Spheroman/t3code && cd t3code
scripts/fork/install-mac.sh
```

It builds an unsigned app for this Mac's architecture and installs
`/Applications/T3 Code (newgit).app`. Nothing it owns collides with
upstream T3 Code, so both run at once:

|                   | Upstream              | This fork                                  |
| ----------------- | --------------------- | ------------------------------------------ |
| App ID            | `com.t3tools.t3code`  | `com.spheroman.t3code-newgit`              |
| State             | `~/.t3`               | `~/.t3-newgit`                             |
| Electron profile  | `t3code-v2`           | `t3code-newgit`                            |
| Keychain item     | `t3code Safe Storage` | `t3code-newgit Safe Storage`               |
| CLI command       | `t3`                  | `t3code-newgit`                            |
| `t3code://` links | handled               | not registered                             |
| Auto-update       | on                    | off, so upstream releases never replace it |

## Settings

- `T3CODE_NEWGIT=0` turns newgit workspaces off.
- `T3CODE_NEWGIT_BIN` names a `newgit` that is not on the server's `PATH`.
  If `newgit` cannot run, the thread gets a Git worktree and the server
  logs why.

## Limits

- Threads keep their temporary `t3code/<hex>` branch name: upstream renames
  a worktree's branch after the first message, and a newgit instance cannot
  be renamed.
- Storage cleanup skips newgit workspaces; `newgit cleanup` owns them.
- MCP `existing_worktree` launches reject newgit workspaces, since they are
  separate clones rather than linked worktrees.
- `stop` and `start` need a newgit with those commands (Spheroman/newgit#157),
  and eviction needs one with `stop --evict` (Spheroman/newgit#427). With an older one they fail,
  the server logs a warning, and settling and turns go on as before. An
  older `remove` never refuses, so it deletes a stopped database's data
  directory without asking; an older `spawn` or `start` exits 0 when not
  ready, and reports no `problems` to show; and an older `start` does not
  rebuild a deleted workspace, so that turn fails with newgit's reason.
- PR review guides still use their own temporary Git worktrees.
- Sign-in flows that return through a `t3code://` link reach upstream
  T3 Code, not this app.
- Eleven upstream desktop and build-script tests assert upstream's app ID,
  state directory, and CLI name, so they fail here. They are left as they
  are to keep upstream merges clean.

## Testing

The newgit tests sit beside the code (`apps/server/src/vcs/newgit*.test.ts`,
and the `newgit` cases in `ProviderTurnStartService.test.ts`). Most point
`T3CODE_NEWGIT_BIN` at a shell script standing in for newgit, which logs its
arguments and prints the report or refusal under test. The ones that need
the real thing are skipped unless `newgit` runs, and the test runner does
not pass `T3CODE_NEWGIT_BIN` through, so put the newgit you are testing
first on `PATH`:

```sh
cd apps/server && PATH=/path/to/newgit/target/debug:$PATH vp test run src/vcs/newgit
```

## Keeping up with upstream

The newgit logic lives in `apps/server/src/vcs/newgitWorkspaces.ts`,
`apps/server/src/orchestration-v2/NewgitLifecycleReactor.ts`,
`apps/web/src/lib/newgitWorkspaceRemoval.ts`, and
`apps/desktop/src/forkIdentity.ts`. Every edit to an upstream file is marked
`newgit fork patch`, so `git grep "newgit fork patch"` lists every hook.

Bring upstream into the fork with a merge, here, on GitHub:

```sh
git remote add upstream https://github.com/pingdotgg/t3code  # once
git fetch upstream
git switch main && git merge --ff-only upstream/main && git push origin main
git switch newgit && git merge main
git grep -n "newgit fork patch"   # check each hook still sits where it should
git push origin newgit
scripts/fork/install-mac.sh
```

Then bring it into newgit, in newgit's project root:

```sh
newgit pull --remote t3code   # t3code's `main` takes what Spheroman/t3code has
newgit pull t3code            # newgit's root pins it: one merge under apps/t3code
newgit merge main             # publish both to newgit.dev
```

A change made in newgit under `apps/t3code` goes the other way: `git push`
from the workspace exports its branch to Spheroman/t3code, where `gh pr
create` opens the pull request.
