import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseChangelog } from "./_changelog_core_bundle.mjs";

const fixture = `# Changelog

## [Unreleased]

### Added

- First line with \`inline_code\`,
  continued on the next line.

### Fixed

- A repair.

## [1.2.3] - 2026-08-15

### Security

- A security update.
`;

assert.deepEqual(parseChangelog(fixture), [
  {
    version: "Unreleased",
    date: undefined,
    sections: [
      {
        name: "Added",
        entries: ["First line with `inline_code`, continued on the next line."],
      },
      { name: "Fixed", entries: ["A repair."] },
    ],
  },
  {
    version: "1.2.3",
    date: "2026-08-15",
    sections: [{ name: "Security", entries: ["A security update."] }],
  },
]);

const current = parseChangelog(readFileSync("CHANGELOG.md", "utf8"));
assert.equal(current[0]?.version, "0.5.0");
assert.equal(current[0]?.date, "2026-08-15");
assert.ok(current.some((release) => release.version === "0.4.0"));
assert.ok(current.every((release) => release.sections.length > 0));
assert.ok(
  current.every((release) =>
    release.sections.every((section) => section.entries.length > 0),
  ),
);

const main = readFileSync("spa/src/main.tsx", "utf8");
const footer = readFileSync("spa/src/components/AppFooter.tsx", "utf8");
const page = readFileSync("spa/src/pages/ChangelogPage.tsx", "utf8");
assert.match(main, /path: "\/changelog"/);
assert.match(main, /import\("\.\/pages\/ChangelogPage"\)/);
assert.ok(
  footer.indexOf('to="/changelog"') > footer.indexOf("t.footer.contact"),
);
assert.match(page, /CHANGELOG\.md\?raw/);
assert.doesNotMatch(page, /dangerouslySetInnerHTML/);

console.log("changelog checks passed");
