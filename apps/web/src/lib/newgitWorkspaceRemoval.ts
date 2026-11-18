/**
 * newgit fork patch: deleting a thread removes its newgit workspace first. newgit refuses a
 * removal that would lose what no checkpoint holds (a database whose dump failed), and the
 * server has already started the instance and tried again by then; the user then deletes
 * anyway or keeps the thread and its workspace as they were.
 */
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { GitCommandError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isGitCommandError = Schema.is(GitCommandError);

/** newgit's own words when it refused to remove a workspace, or null for any other failure. */
export function newgitRemovalRefusal(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const error = squashAtomCommandFailure(result);
  return isGitCommandError(error) && error.reason === "newgit_remove_refused" ? error.detail : null;
}

export type NewgitRemovalOutcome<E> =
  | { readonly kind: "kept" }
  | { readonly kind: "done"; readonly result: AtomCommandResult<void, E> };

/**
 * `kept` when newgit refused and the user kept the workspace, so the thread stays too.
 * Otherwise the removal's result, after the user chose to delete anyway if newgit refused.
 */
export async function removeNewgitWorkspaceFirst<E>(input: {
  readonly remove: (newgitForce: boolean) => Promise<AtomCommandResult<void, E>>;
  readonly confirmDeleteAnyway: (refusal: string) => Promise<boolean>;
}): Promise<NewgitRemovalOutcome<E>> {
  const result = await input.remove(false);
  const refusal = newgitRemovalRefusal(result);
  if (refusal === null) return { kind: "done", result };
  if (!(await input.confirmDeleteAnyway(refusal))) return { kind: "kept" };
  return { kind: "done", result: await input.remove(true) };
}
