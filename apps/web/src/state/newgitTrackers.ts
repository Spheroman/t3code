/** newgit fork patch: the trackers a new newgit workspace may bind, and the user's choice. */
import { WS_METHODS, type NewgitTrackerChoice } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";
import type { NewgitTrackerOverrides } from "../lib/newgitTrackerChoice";

export const newgitTrackerList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:newgit:trackers",
  tag: WS_METHODS.vcsListNewgitTrackers,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

interface NewgitTrackerChoiceState {
  /** Keyed by the draft thread's id, which the send uses as the new thread's id. */
  readonly byThreadId: Readonly<
    Record<
      string,
      {
        readonly overrides: NewgitTrackerOverrides;
        readonly choice: NewgitTrackerChoice | undefined;
      }
    >
  >;
  readonly setChoice: (
    threadId: string,
    overrides: NewgitTrackerOverrides,
    choice: NewgitTrackerChoice | undefined,
  ) => void;
}

export const useNewgitTrackerChoiceStore = create<NewgitTrackerChoiceState>()((set) => ({
  byThreadId: {},
  setChoice: (threadId, overrides, choice) =>
    set((state) => ({ byThreadId: { ...state.byThreadId, [threadId]: { overrides, choice } } })),
}));

/** The `--use`/`--drop` a send passes for this draft's new worktree, if any. */
export function newgitTrackerChoiceForThread(threadId: string): NewgitTrackerChoice | undefined {
  return useNewgitTrackerChoiceStore.getState().byThreadId[threadId]?.choice;
}

/** Spread into `prepareWorktree`: the draft's tracker choice, when it has one. */
export function newgitTrackerChoiceField(threadId: string): {
  newgitTrackers?: NewgitTrackerChoice;
} {
  const choice = newgitTrackerChoiceForThread(threadId);
  return choice === undefined ? {} : { newgitTrackers: choice };
}
