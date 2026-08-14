export type ChangelogSection = {
  name: string;
  entries: string[];
};

export type ChangelogRelease = {
  version: string;
  date?: string;
  sections: ChangelogSection[];
};

const releasePattern = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;
const sectionPattern = /^### (.+?)\s*$/;
const entryPattern = /^- (.+)$/;

export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | null = null;
  let section: ChangelogSection | null = null;
  let entryParts: string[] = [];

  const flushEntry = () => {
    if (section && entryParts.length > 0) {
      section.entries.push(entryParts.join(" "));
    }
    entryParts = [];
  };

  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    const releaseMatch = releasePattern.exec(line);
    if (releaseMatch) {
      flushEntry();
      release = {
        version: releaseMatch[1],
        date: releaseMatch[2],
        sections: [],
      };
      releases.push(release);
      section = null;
      continue;
    }

    const sectionMatch = sectionPattern.exec(line);
    if (sectionMatch && release) {
      flushEntry();
      section = { name: sectionMatch[1], entries: [] };
      release.sections.push(section);
      continue;
    }

    const entryMatch = entryPattern.exec(line);
    if (entryMatch && section) {
      flushEntry();
      entryParts = [entryMatch[1].trim()];
      continue;
    }

    if (/^\s{2,}\S/.test(rawLine) && entryParts.length > 0) {
      entryParts.push(line.trim());
    }
  }

  flushEntry();
  return releases.filter((item) =>
    item.sections.some((itemSection) => itemSection.entries.length > 0),
  );
}
