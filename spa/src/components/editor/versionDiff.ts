export type VersionDiffLine = {
  kind: "equal" | "add" | "remove" | "omitted";
  text: string;
  oldLine: number | null;
  newLine: number | null;
  omitted?: number;
};

export type VersionDiffResult = {
  lines: VersionDiffLine[];
  added: number;
  removed: number;
  changed: boolean;
};

type DiffOperation = { kind: "equal" | "add" | "remove"; text: string };

const MAX_LCS_CELLS = 100_000;
const CONTEXT_LINES = 3;
const MAX_RENDERED_LINES = 4_000;

export function buildVersionDiff(before: string, after: string): VersionDiffResult {
  const operations = diffOperations(splitLines(before), splitLines(after));
  const added = operations.reduce((count, operation) => count + (operation.kind === "add" ? 1 : 0), 0);
  const removed = operations.reduce((count, operation) => count + (operation.kind === "remove" ? 1 : 0), 0);
  return {
    lines: capRenderedLines(collapseEqualRuns(numberOperations(operations))),
    added,
    removed,
    changed: added > 0 || removed > 0,
  };
}

function splitLines(value: string): string[] {
  return value === "" ? [] : value.replace(/\r\n?/g, "\n").split("\n");
}

function diffOperations(before: string[], after: string[]): DiffOperation[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;

  const operations: DiffOperation[] = before.slice(0, prefix).map((text) => ({ kind: "equal", text }));
  operations.push(...diffMiddle(before.slice(prefix, before.length - suffix), after.slice(prefix, after.length - suffix)));
  operations.push(...before.slice(before.length - suffix).map((text) => ({ kind: "equal" as const, text })));
  return operations;
}

function diffMiddle(before: string[], after: string[]): DiffOperation[] {
  if (before.length === 0) return after.map((text) => ({ kind: "add", text }));
  if (after.length === 0) return before.map((text) => ({ kind: "remove", text }));
  if (before.length * after.length > MAX_LCS_CELLS) {
    return [...before.map((text) => ({ kind: "remove" as const, text })), ...after.map((text) => ({ kind: "add" as const, text }))];
  }

  const lengths = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      lengths[left][right] = before[left] === after[right]
        ? lengths[left + 1][right + 1] + 1
        : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    }
  }

  const operations: DiffOperation[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      operations.push({ kind: "equal", text: before[left] });
      left += 1;
      right += 1;
    } else if (lengths[left + 1][right] >= lengths[left][right + 1]) {
      operations.push({ kind: "remove", text: before[left++] });
    } else {
      operations.push({ kind: "add", text: after[right++] });
    }
  }
  while (left < before.length) operations.push({ kind: "remove", text: before[left++] });
  while (right < after.length) operations.push({ kind: "add", text: after[right++] });
  return operations;
}

function numberOperations(operations: DiffOperation[]): VersionDiffLine[] {
  let oldLine = 1;
  let newLine = 1;
  return operations.map((operation) => {
    const line: VersionDiffLine = {
      ...operation,
      oldLine: operation.kind === "add" ? null : oldLine,
      newLine: operation.kind === "remove" ? null : newLine,
    };
    if (operation.kind !== "add") oldLine += 1;
    if (operation.kind !== "remove") newLine += 1;
    return line;
  });
}

function collapseEqualRuns(lines: VersionDiffLine[]): VersionDiffLine[] {
  const result: VersionDiffLine[] = [];
  for (let index = 0; index < lines.length;) {
    if (lines[index].kind !== "equal") {
      result.push(lines[index++]);
      continue;
    }
    let end = index + 1;
    while (end < lines.length && lines[end].kind === "equal") end += 1;
    const run = lines.slice(index, end);
    if (run.length <= CONTEXT_LINES * 2 + 1) {
      result.push(...run);
    } else {
      result.push(...run.slice(0, CONTEXT_LINES));
      result.push({ kind: "omitted", text: "", oldLine: null, newLine: null, omitted: run.length - CONTEXT_LINES * 2 });
      result.push(...run.slice(-CONTEXT_LINES));
    }
    index = end;
  }
  return result;
}

function capRenderedLines(lines: VersionDiffLine[]): VersionDiffLine[] {
  if (lines.length <= MAX_RENDERED_LINES) return lines;
  const head = Math.floor(MAX_RENDERED_LINES / 2);
  const tail = MAX_RENDERED_LINES - head;
  return [...lines.slice(0, head), { kind: "omitted", text: "", oldLine: null, newLine: null, omitted: lines.length - MAX_RENDERED_LINES }, ...lines.slice(-tail)];
}
