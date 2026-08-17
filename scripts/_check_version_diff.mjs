import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildVersionDiff } from "./_version_diff_bundle.mjs";

const unchanged = buildVersionDiff("one\ntwo", "one\ntwo");
assert.equal(unchanged.changed, false);
assert.equal(unchanged.added, 0);
assert.equal(unchanged.removed, 0);

const replaced = buildVersionDiff("one\ntwo\nthree", "one\nTWO\nthree");
assert.equal(replaced.changed, true);
assert.equal(replaced.added, 1);
assert.equal(replaced.removed, 1);
assert.deepEqual(replaced.lines.filter((line) => line.kind !== "equal").map((line) => [line.kind, line.text]), [["remove", "two"], ["add", "TWO"]]);

const inserted = buildVersionDiff("甲\n乙", "甲\n新增\n乙");
assert.equal(inserted.added, 1);
assert.equal(inserted.removed, 0);
assert.equal(inserted.lines.find((line) => line.kind === "add")?.newLine, 2);

const largeBefore = Array.from({ length: 5_000 }, (_, index) => `old-${index}`).join("\n");
const largeAfter = Array.from({ length: 5_000 }, (_, index) => `new-${index}`).join("\n");
const large = buildVersionDiff(largeBefore, largeAfter);
assert.equal(large.added, 5_000);
assert.equal(large.removed, 5_000);
assert.ok(large.lines.length <= 4_001, "large diffs must cap rendered rows");
assert.ok(large.lines.some((line) => line.kind === "omitted"), "large diffs need an omission marker");

const dialog = readFileSync("spa/src/components/editor/VersionHistoryDialog.tsx", "utf8");
assert.match(dialog, /interpolate\(t\.editor\.historyTitleChanged/);
assert.match(dialog, /interpolate\(t\.editor\.historyLinesOmitted/);
assert.doesNotMatch(dialog, /historyTitleChanged[\s\S]{0,100}\.replace\(/);

console.log("version diff checks passed");
