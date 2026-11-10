import type { NewgitTracker } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isTrackerChecked,
  selectedRoleMember,
  selectRoleMember,
  toggleTracker,
  trackerChoiceFor,
  trackerRows,
} from "./newgitTrackerChoice";

const tracker = (name: string, fields: Partial<NewgitTracker> = {}): NewgitTracker => ({
  name,
  parent: null,
  paths: [name],
  git: true,
  role: null,
  priority: 0,
  requires: [],
  selectable: true,
  defaultBound: true,
  ...fields,
});

// This repo's own trackers, plus a role and a `requires`.
const trackers: NewgitTracker[] = [
  tracker("root", { paths: ["."], selectable: false }),
  tracker("access", { selectable: false }),
  tracker("t3code", { priority: -1, defaultBound: false }),
  tracker("t3code/repos", { parent: "t3code", priority: -1, defaultBound: false }),
  tracker("agent-notes", { git: false }),
  tracker("dev-db", { role: "db", priority: 1 }),
  tracker("prod-db", { role: "db", defaultBound: false }),
  tracker("seed", { requires: ["db"], priority: -1, defaultBound: false }),
];

describe("newgit tracker choice", () => {
  it("starts from what spawn binds by default, and sends nothing for it", () => {
    expect(trackers.filter((t) => isTrackerChecked(t, {})).map((t) => t.name)).toEqual([
      "root",
      "access",
      "agent-notes",
      "dev-db",
    ]);
    expect(trackerChoiceFor(trackers, {})).toBeUndefined();
  });

  it("lists only selectable trackers, children under their parent, and a role as one row", () => {
    expect(
      trackerRows(trackers).map((row) =>
        row.kind === "role"
          ? [`role ${row.role}`, row.members.map((member) => member.name), row.depth]
          : [row.tracker.name, row.depth],
      ),
    ).toEqual([
      ["t3code", 0],
      ["t3code/repos", 1],
      ["agent-notes", 0],
      ["role db", ["dev-db", "prod-db"], 0],
      ["seed", 0],
    ]);
  });

  it("fills a role with one of its trackers, or none", () => {
    const members = trackers.filter((t) => t.role === "db");
    expect(selectedRoleMember(members, {})?.name).toBe("dev-db");

    let overrides = selectRoleMember(trackers, {}, "db", "prod-db");
    expect(selectedRoleMember(members, overrides)?.name).toBe("prod-db");
    expect(trackerChoiceFor(trackers, overrides)).toEqual({ use: ["prod-db"], drop: ["dev-db"] });

    overrides = selectRoleMember(trackers, overrides, "db", null);
    expect(selectedRoleMember(members, overrides)).toBeNull();
    expect(trackerChoiceFor(trackers, overrides)).toEqual({ use: [], drop: ["dev-db"] });
  });

  it("a role set to none takes what requires it along", () => {
    let overrides = toggleTracker(trackers, {}, "seed", true);
    overrides = selectRoleMember(trackers, overrides, "db", null);
    expect(
      isTrackerChecked(
        trackers.find((t) => t.name === "seed")!,
        overrides,
      ),
    ).toBe(false);
  });

  it("checking a child checks its parent", () => {
    const overrides = toggleTracker(trackers, {}, "t3code/repos", true);
    expect(trackerChoiceFor(trackers, overrides)).toEqual({
      use: ["t3code", "t3code/repos"],
      drop: [],
    });
  });

  it("unchecking a parent unchecks its children", () => {
    let overrides = toggleTracker(trackers, {}, "t3code/repos", true);
    overrides = toggleTracker(trackers, overrides, "t3code", false);
    expect(trackerChoiceFor(trackers, overrides)).toBeUndefined();
  });

  it("checking one tracker in a role unchecks the others", () => {
    const overrides = toggleTracker(trackers, {}, "prod-db", true);
    expect(trackerChoiceFor(trackers, overrides)).toEqual({ use: ["prod-db"], drop: ["dev-db"] });
  });

  it("unchecking what a checked tracker requires unchecks that tracker", () => {
    let overrides = toggleTracker(trackers, {}, "seed", true);
    expect(trackerChoiceFor(trackers, overrides)).toEqual({ use: ["seed"], drop: [] });
    overrides = toggleTracker(trackers, overrides, "dev-db", false);
    expect(
      isTrackerChecked(
        trackers.find((t) => t.name === "seed")!,
        overrides,
      ),
    ).toBe(false);
    expect(trackerChoiceFor(trackers, overrides)).toEqual({ use: [], drop: ["dev-db"] });
  });

  it("drops a default tracker the user unchecks", () => {
    const overrides = toggleTracker(trackers, {}, "agent-notes", false);
    expect(trackerChoiceFor(trackers, overrides)).toEqual({ use: [], drop: ["agent-notes"] });
  });
});
