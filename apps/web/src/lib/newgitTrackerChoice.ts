/**
 * newgit fork patch: which trackers a new newgit workspace binds, chosen in the new-thread
 * panel. The panel keeps the user's explicit choices; what is sent to `newgit spawn` is only
 * where they differ from what it binds by default, as `--use`/`--drop`.
 */
import type { NewgitTracker, NewgitTrackerChoice } from "@t3tools/contracts";

/** Tracker name → checked, for the trackers the user touched (directly or by cascade). */
export type NewgitTrackerOverrides = Readonly<Record<string, boolean>>;

export function isTrackerChecked(tracker: NewgitTracker, overrides: NewgitTrackerOverrides) {
  return overrides[tracker.name] ?? tracker.defaultBound ?? false;
}

/**
 * Check or uncheck one tracker the way `newgit spawn` would resolve it, so the boxes never
 * show a binding newgit would refuse: checking one checks its parent and what it requires and
 * unchecks the other trackers in its role; unchecking one unchecks the trackers under it and
 * those that require it.
 */
export function toggleTracker(
  trackers: ReadonlyArray<NewgitTracker>,
  overrides: NewgitTrackerOverrides,
  name: string,
  checked: boolean,
): NewgitTrackerOverrides {
  const byName = new Map(trackers.map((tracker) => [tracker.name, tracker]));
  const next: Record<string, boolean> = { ...overrides };
  // Each tracker is decided once, so trackers that require each other cannot loop.
  const decided = new Set<string>();
  const visit = (current: string, value: boolean) => {
    const tracker = byName.get(current);
    if (tracker === undefined || !tracker.selectable || decided.has(current)) return;
    decided.add(current);
    next[current] = value;
    if (value) {
      if (tracker.parent !== null) visit(tracker.parent, true);
      for (const needed of tracker.requires) {
        if (byName.has(needed)) {
          visit(needed, true);
        } else if (
          !trackers.some((other) => other.role === needed && isTrackerChecked(other, next))
        ) {
          // A required role: fill it as newgit would, with its default member.
          const member = trackers.find((other) => other.role === needed && other.defaultBound);
          if (member) visit(member.name, true);
        }
      }
      if (tracker.role !== null) {
        for (const other of trackers) {
          if (
            other.name !== current &&
            other.role === tracker.role &&
            isTrackerChecked(other, next)
          )
            visit(other.name, false);
        }
      }
    } else {
      for (const other of trackers) {
        if (!isTrackerChecked(other, next)) continue;
        const requiresThis =
          other.requires.includes(current) ||
          (tracker.role !== null &&
            other.requires.includes(tracker.role) &&
            !trackers.some(
              (member) =>
                member.name !== current &&
                member.role === tracker.role &&
                isTrackerChecked(member, next),
            ));
        if (other.parent === current || requiresThis) visit(other.name, false);
      }
    }
  };
  visit(name, checked);
  return next;
}

/** What `newgit spawn` needs to bind the checked trackers; undefined when it is the default. */
export function trackerChoiceFor(
  trackers: ReadonlyArray<NewgitTracker>,
  overrides: NewgitTrackerOverrides,
): NewgitTrackerChoice | undefined {
  const use: string[] = [];
  const drop: string[] = [];
  for (const tracker of trackers) {
    const checked = overrides[tracker.name];
    if (!tracker.selectable || checked === undefined) continue;
    if (checked && tracker.defaultBound !== true) use.push(tracker.name);
    if (!checked && tracker.defaultBound !== false) drop.push(tracker.name);
  }
  return use.length === 0 && drop.length === 0 ? undefined : { use, drop };
}

/** The member that fills `members`' role, or null when none does. */
export function selectedRoleMember(
  members: ReadonlyArray<NewgitTracker>,
  overrides: NewgitTrackerOverrides,
): NewgitTracker | null {
  return members.find((member) => isTrackerChecked(member, overrides)) ?? null;
}

/** Fill a role with one of its trackers, or with none (`null`). */
export function selectRoleMember(
  trackers: ReadonlyArray<NewgitTracker>,
  overrides: NewgitTrackerOverrides,
  role: string,
  name: string | null,
): NewgitTrackerOverrides {
  // Checking one member unchecks the others in its role.
  if (name !== null) return toggleTracker(trackers, overrides, name, true);
  let next = overrides;
  for (const member of trackers) {
    if (member.role === role && isTrackerChecked(member, next)) {
      next = toggleTracker(trackers, next, member.name, false);
    }
  }
  return next;
}

export type NewgitTrackerRow =
  | { readonly kind: "tracker"; readonly tracker: NewgitTracker; readonly depth: number }
  | {
      readonly kind: "role";
      readonly role: string;
      readonly members: ReadonlyArray<NewgitTracker>;
      readonly depth: number;
    };

/**
 * The selectable trackers in display order, each under the tracker that defines it. A role's
 * trackers are alternatives, so they share one row, where the first of them would sit; the
 * trackers under any of them follow it.
 */
export function trackerRows(
  trackers: ReadonlyArray<NewgitTracker>,
): ReadonlyArray<NewgitTrackerRow> {
  const selectable = trackers.filter((tracker) => tracker.selectable);
  const names = new Set(selectable.map((tracker) => tracker.name));
  const parentOf = (tracker: NewgitTracker) =>
    tracker.parent !== null && names.has(tracker.parent) ? tracker.parent : null;
  const rows: NewgitTrackerRow[] = [];
  const placedRoles = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const tracker of selectable) {
      if (parentOf(tracker) !== parent) continue;
      if (tracker.role === null) {
        rows.push({ kind: "tracker", tracker, depth });
        walk(tracker.name, depth + 1);
        continue;
      }
      if (placedRoles.has(tracker.role)) continue;
      placedRoles.add(tracker.role);
      const members = selectable.filter((member) => member.role === tracker.role);
      rows.push({ kind: "role", role: tracker.role, members, depth });
      for (const member of members) walk(member.name, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}
