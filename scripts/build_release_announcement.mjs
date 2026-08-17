import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJSON = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = String(packageJSON.version ?? "").trim();
const output = resolve(
  root,
  process.env.RELEASE_ANNOUNCEMENT_OUTPUT || "backend/release-announcement.json",
);
const maxTitleCharacters = 160;
const maxSummaryCharacters = 600;
const maxHighlightCharacters = 500;
const maxReleaseHighlights = 6;

const locales = {
  en: {
    file: "CHANGELOG.md",
    title: `What's new in Koinote ${version}`,
    summary: "A quick look at the improvements now available in Koinote.",
  },
  zh: {
    file: "CHANGELOG.zh.md",
    title: `Koinote ${version} 新功能`,
    summary: "快速了解这个版本已经可以使用的重要升级。",
  },
  fr: {
    file: "CHANGELOG.fr.md",
    title: `Nouveautés de Koinote ${version}`,
    summary: "Découvrez rapidement les principales améliorations disponibles dans cette version.",
  },
  ja: {
    file: "CHANGELOG.ja.md",
    title: `Koinote ${version} の新機能`,
    summary: "このバージョンで利用できる主な改善点をすばやく確認できます。",
  },
};

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package.json version is not valid semver: ${version}`);
}

function parseRelease(markdown, wantedVersion) {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const heading = new RegExp(
    `^## \\[${wantedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\](?: - (\\d{4}-\\d{2}-\\d{2}))?\\s*$`,
    "m",
  );
  const match = heading.exec(normalized);
  if (!match) throw new Error(`CHANGELOG is missing release ${wantedVersion}`);
  const rest = normalized.slice(match.index + match[0].length);
  const nextRelease = rest.search(/^## \[/m);
  const block = nextRelease >= 0 ? rest.slice(0, nextRelease) : rest;
  const sections = new Map();
  let section = "";
  let entry = null;

  const flush = () => {
    if (!section || !entry) return;
    const values = sections.get(section) ?? [];
    values.push(entry.join(" ").replace(/\s+/g, " ").trim());
    sections.set(section, values);
    entry = null;
  };

  for (const rawLine of block.split("\n")) {
    const sectionMatch = /^### (.+?)\s*$/.exec(rawLine);
    if (sectionMatch) {
      flush();
      section = sectionMatch[1];
      continue;
    }
    const entryMatch = /^- (.+)$/.exec(rawLine);
    if (entryMatch && section) {
      flush();
      entry = [entryMatch[1].trim()];
      continue;
    }
    if (/^\s{2,}\S/.test(rawLine) && entry) entry.push(rawLine.trim());
  }
  flush();
  return { date: match[1], sections };
}

function characterCount(value) {
  return [...value].length;
}

function validateTranslation(locale, translation) {
  const titleLength = characterCount(translation.title);
  const summaryLength = characterCount(translation.summary);
  if (titleLength < 1 || titleLength > maxTitleCharacters) {
    throw new Error(`${locale} announcement title must contain 1–${maxTitleCharacters} characters`);
  }
  if (summaryLength < 1 || summaryLength > maxSummaryCharacters) {
    throw new Error(`${locale} announcement summary must contain 1–${maxSummaryCharacters} characters`);
  }
  if (
    translation.highlights.length < 1 ||
    translation.highlights.length > maxReleaseHighlights
  ) {
    throw new Error(`${locale} announcement must contain 1–${maxReleaseHighlights} highlights`);
  }
  translation.highlights.forEach((highlight, index) => {
    const length = characterCount(highlight);
    if (length < 1 || length > maxHighlightCharacters) {
      throw new Error(
        `${locale} announcement highlight ${index + 1} must contain 1–${maxHighlightCharacters} characters`,
      );
    }
  });
}

const translations = {};
let releaseDate = "";
for (const [locale, metadata] of Object.entries(locales)) {
  const parsed = parseRelease(
    readFileSync(resolve(root, metadata.file), "utf8"),
    version,
  );
  if (!parsed.date) throw new Error(`${metadata.file} release ${version} has no date`);
  if (releaseDate && releaseDate !== parsed.date) {
    throw new Error(`release ${version} dates differ across changelogs`);
  }
  releaseDate = parsed.date;
  const highlights = [
    ...(parsed.sections.get("Added") ?? []),
    ...(parsed.sections.get("Changed") ?? []),
  ].slice(0, maxReleaseHighlights);
  if (highlights.length === 0) {
    throw new Error(`${metadata.file} release ${version} has no Added/Changed highlights`);
  }
  const translation = {
    title: metadata.title,
    summary: metadata.summary,
    highlights,
  };
  validateTranslation(locale, translation);
  translations[locale] = translation;
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  `${JSON.stringify(
    {
      version,
      translations,
    },
    null,
    2,
  )}\n`,
);
console.log(`Generated release announcement ${version} → ${output}`);
