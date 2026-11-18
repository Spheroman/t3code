import { GitCommandError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { removeNewgitWorkspaceFirst } from "./newgitWorkspaceRemoval";

const failure = (reason?: "newgit_remove_refused") =>
  AsyncResult.failure<void, GitCommandError>(
    Cause.fail(
      new GitCommandError({
        operation: "newgitWorkspaces.remove",
        command: "newgit remove",
        cwd: "/p",
        detail: "not removing `feature`: the capture of `db` failed",
        ...(reason === undefined ? {} : { reason }),
      }),
    ),
  );
const removed = AsyncResult.success<void, GitCommandError>(undefined);

describe("removeNewgitWorkspaceFirst", () => {
  it("keeps the thread when newgit refuses and the user keeps the workspace", async () => {
    const remove = vi.fn(async () => failure("newgit_remove_refused"));
    const confirmDeleteAnyway = vi.fn(async () => false);
    expect(await removeNewgitWorkspaceFirst({ remove, confirmDeleteAnyway })).toEqual({
      kind: "kept",
    });
    expect(confirmDeleteAnyway).toHaveBeenCalledWith(
      "not removing `feature`: the capture of `db` failed",
    );
    expect(remove.mock.calls).toEqual([[false]]);
  });

  it("forces the removal when the user deletes anyway", async () => {
    const remove = vi.fn(async (force: boolean) =>
      force ? removed : failure("newgit_remove_refused"),
    );
    const outcome = await removeNewgitWorkspaceFirst({
      remove,
      confirmDeleteAnyway: async () => true,
    });
    expect(outcome).toEqual({ kind: "done", result: removed });
    expect(remove.mock.calls).toEqual([[false], [true]]);
  });

  it("asks nothing when the removal succeeds or fails for another reason", async () => {
    const confirmDeleteAnyway = vi.fn(async () => true);
    const other = failure();
    expect(
      await removeNewgitWorkspaceFirst({ remove: async () => other, confirmDeleteAnyway }),
    ).toEqual({ kind: "done", result: other });
    expect(
      await removeNewgitWorkspaceFirst({ remove: async () => removed, confirmDeleteAnyway }),
    ).toEqual({ kind: "done", result: removed });
    expect(confirmDeleteAnyway).not.toHaveBeenCalled();
  });
});
