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

const changelogMarkdown = readFileSync("CHANGELOG.md", "utf8");
const current = parseChangelog(changelogMarkdown);
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
assert.match(changelogMarkdown, /^## \[Unreleased\]\s*$/m);
assert.equal(current[0]?.version, "Unreleased");
assert.equal(current[0]?.date, undefined);
const currentRelease = current.find((release) => release.version === packageVersion);
assert.ok(currentRelease, `missing package release ${packageVersion}`);
assert.match(currentRelease.date ?? "", /^\d{4}-\d{2}-\d{2}$/);
const previousRelease = current.find((release) => release.version === "0.5.0");
assert.equal(previousRelease?.date, "2026-08-15");
assert.ok(current.some((release) => release.version === "0.4.0"));
assert.ok(current.every((release) => release.sections.length > 0));
assert.ok(
  current.every((release) =>
    release.sections.every((section) => section.entries.length > 0),
  ),
);

const localizedFiles = [
  "CHANGELOG.zh.md",
  "CHANGELOG.ja.md",
  "CHANGELOG.fr.md",
];
const expectedVersions = current.map((release) => release.version);
for (const localizedFile of localizedFiles) {
  const localized = parseChangelog(readFileSync(localizedFile, "utf8"));
  assert.deepEqual(
    localized.map((release) => release.version),
    expectedVersions,
    `${localizedFile} must contain the same releases as CHANGELOG.md`,
  );
  assert.ok(
    localized.every((release) =>
      release.sections.every((section) => section.entries.length > 0),
    ),
  );
}
assert.ok(
  current.every(
    (release) =>
      release.sections.reduce(
        (count, section) => count + section.entries.length,
        0,
      ) <= 30,
  ),
  "each public release should stay concise",
);

const main = readFileSync("spa/src/main.tsx", "utf8");
const footer = readFileSync("spa/src/components/AppFooter.tsx", "utf8");
const page = readFileSync("spa/src/pages/ChangelogPage.tsx", "utf8");
assert.match(main, /path: "\/changelog"/);
assert.match(main, /import\("\.\/pages\/ChangelogPage"\)/);
assert.ok(
  footer.indexOf('to="/changelog"') > footer.indexOf("t.footer.contact"),
);
for (const filename of [
  "CHANGELOG.md",
  "CHANGELOG.zh.md",
  "CHANGELOG.ja.md",
  "CHANGELOG.fr.md",
]) {
  assert.ok(page.includes(`${filename}?raw`), `${filename} must be bundled`);
}
assert.match(page, /CHANGELOGS\[locale\]/);
assert.match(page, /label=\{t\.changelog\.newLabel\}/);
assert.doesNotMatch(page, /label="新"/);
assert.doesNotMatch(page, /dangerouslySetInnerHTML/);

console.log("changelog checks passed");
