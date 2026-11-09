/**
 * newgit fork patch: in a newgit project, the new-thread panel lists the trackers a new
 * worktree may bind, set as `newgit spawn` would bind them by default. A tracker is a
 * checkbox; a role is one dropdown, since its trackers are alternatives: one of them, or none.
 * Each change becomes `--use`/`--drop` on the spawn.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, NewgitTracker, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { LayersIcon } from "lucide-react";

import {
  isTrackerChecked,
  selectedRoleMember,
  selectRoleMember,
  toggleTracker,
  trackerChoiceFor,
  trackerRows,
  type NewgitTrackerOverrides,
} from "../../lib/newgitTrackerChoice";
import { cn } from "../../lib/utils";
import { newgitTrackerList, useNewgitTrackerChoiceStore } from "../../state/newgitTrackers";
import { Checkbox } from "../ui/checkbox";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItemDetail,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_ROW_CLASS,
} from "./threadDetailsPanelStyles";

const NO_OVERRIDES: NewgitTrackerOverrides = {};
// Menu radio values are strings; no tracker is named this, since names have no spaces.
const NO_MEMBER = "none ";

function describeTracker(tracker: NewgitTracker): string {
  const parts = [tracker.paths.length > 0 ? tracker.paths.join(", ") : "no paths"];
  if (!tracker.git) parts.push("outside Git");
  if (tracker.defaultBound === false) parts.push("bound only when asked for");
  if (tracker.requires.length > 0) parts.push(`requires ${tracker.requires.join(", ")}`);
  return parts.join(" · ");
}

// A child row shows only its own name; its parent is the row above.
const shortName = (tracker: NewgitTracker, depth: number) =>
  tracker.parent !== null && depth > 0
    ? tracker.name.slice(tracker.parent.length + 1)
    : tracker.name;

const indent = (depth: number) => (depth > 0 ? { marginInlineStart: depth * 16 } : undefined);

const DETAIL_CLASS = cn(
  "ml-auto min-w-0 truncate text-xs font-normal text-muted-foreground",
  THREAD_DETAILS_PANEL_LABEL_CLASS,
);

export function NewgitTrackersPanel(props: {
  environmentId: EnvironmentId;
  cwd: string;
  threadId: ThreadId;
}) {
  const result = useAtomValue(
    newgitTrackerList({ environmentId: props.environmentId, input: { cwd: props.cwd } }),
  );
  const overrides = useNewgitTrackerChoiceStore(
    (state) => state.byThreadId[props.threadId]?.overrides ?? NO_OVERRIDES,
  );
  const setChoice = useNewgitTrackerChoiceStore((state) => state.setChoice);
  const trackers = AsyncResult.getOrElse(result, () => null)?.trackers ?? null;
  if (trackers === null) return null;
  const rows = trackerRows(trackers);
  if (rows.length === 0) return null;
  const commit = (next: NewgitTrackerOverrides) =>
    setChoice(props.threadId, next, trackerChoiceFor(trackers, next));

  return (
    <div
      role="group"
      aria-labelledby="thread-details-newgit-trackers-heading"
      className="flex flex-col"
    >
      <div
        id="thread-details-newgit-trackers-heading"
        className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground"
      >
        Trackers
      </div>
      {rows.map((row) => {
        if (row.kind === "role") {
          const selected = selectedRoleMember(row.members, overrides);
          return (
            <Menu key={`role:${row.role}`}>
              <MenuTrigger
                render={<ThreadDetailsControl part="select" />}
                aria-label={`Role ${row.role}: ${selected?.name ?? "none"}`}
              >
                <LayersIcon
                  className={THREAD_DETAILS_PANEL_ICON_CLASS}
                  style={indent(row.depth)}
                  aria-hidden
                />
                <span className={cn("min-w-0 shrink-0", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                  {row.role}
                </span>
                <span className={DETAIL_CLASS}>
                  {selected ? shortName(selected, row.depth) : "None"}
                </span>
              </MenuTrigger>
              <MenuPopup align="start" side="bottom" className="w-(--anchor-width)">
                <MenuGroup>
                  <MenuGroupLabel>{row.role}</MenuGroupLabel>
                  <MenuRadioGroup
                    value={selected?.name ?? NO_MEMBER}
                    onValueChange={(value: string) =>
                      commit(
                        selectRoleMember(
                          trackers,
                          overrides,
                          row.role,
                          value === NO_MEMBER ? null : value,
                        ),
                      )
                    }
                  >
                    {row.members.map((member) => (
                      <MenuRadioItem key={member.name} value={member.name} closeOnClick>
                        <span className="flex min-w-0 items-center">
                          <span className="min-w-0 truncate">{member.name}</span>
                          <MenuItemDetail>{member.paths.join(", ")}</MenuItemDetail>
                        </span>
                      </MenuRadioItem>
                    ))}
                    <MenuRadioItem value={NO_MEMBER} closeOnClick>
                      None
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </MenuGroup>
              </MenuPopup>
            </Menu>
          );
        }
        const { tracker, depth } = row;
        return (
          <Tooltip key={tracker.name}>
            <TooltipTrigger
              render={
                <label
                  className={cn(THREAD_DETAILS_PANEL_ROW_CLASS, "flex cursor-pointer items-center")}
                />
              }
            >
              <Checkbox
                checked={isTrackerChecked(tracker, overrides)}
                style={indent(depth)}
                onCheckedChange={(next) =>
                  commit(toggleTracker(trackers, overrides, tracker.name, next))
                }
              />
              <span className={cn("min-w-0 shrink-0", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                {shortName(tracker, depth)}
              </span>
              <span className={DETAIL_CLASS}>{tracker.paths.join(", ")}</span>
            </TooltipTrigger>
            <TooltipPopup side="left">{describeTracker(tracker)}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
