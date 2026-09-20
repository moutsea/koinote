import type { TreeSelectionItem } from "./treeSelection";

export type DragPayload =
  | { kind: "doc"; id: string; ids?: string[]; selection?: TreeSelectionItem[] }
  | { kind: "folder"; id: string; selection?: TreeSelectionItem[] };

export function documentIds(payload: DragPayload): string[] {
  if (payload.kind !== "doc") return [];
  return [...new Set([payload.id, ...(payload.ids ?? [])])];
}

export function sameTreeDragPayload(
  left: DragPayload | null | undefined,
  right: DragPayload | null | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind || left.id !== right.id) return false;
  if (left.selection || right.selection) {
    const leftSelection = (left.selection ?? [{ kind: left.kind, id: left.id }])
      .map((item) => `${item.kind}:${item.id}`)
      .sort();
    const rightSelection = (right.selection ?? [{ kind: right.kind, id: right.id }])
      .map((item) => `${item.kind}:${item.id}`)
      .sort();
    return leftSelection.length === rightSelection.length &&
      leftSelection.every((key, index) => key === rightSelection[index]);
  }
  if (left.kind !== "doc" || right.kind !== "doc") return true;
  const leftIds = documentIds(left).sort();
  const rightIds = documentIds(right).sort();
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
}

export const TREE_DRAG_MIME = "application/x-koinote-tree-item";
const TREE_DRAG_TEXT_PREFIX = "koinote-tree:";

type TreeDragWriter = Pick<DataTransfer, "effectAllowed" | "setData">;
type TreeDragReader = Pick<DataTransfer, "getData">;

function parseTreeDragPayload(value: string): DragPayload | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as {
      kind?: unknown;
      id?: unknown;
      ids?: unknown;
      selection?: unknown;
    };
    if (candidate.kind !== "doc" && candidate.kind !== "folder") return null;
    if (typeof candidate.id !== "string" || candidate.id.trim() === "") return null;
    if (candidate.kind === "folder") {
      const selection = parseSelection(candidate.selection);
      return {
        kind: "folder",
        id: candidate.id,
        ...(selection ? { selection } : {}),
      };
    }
    const ids = Array.isArray(candidate.ids)
      ? [...new Set(candidate.ids.filter((id): id is string => typeof id === "string" && id.trim() !== ""))]
      : [];
    const selection = parseSelection(candidate.selection);
    return {
      kind: "doc",
      id: candidate.id,
      ...(ids.length > 1 ? { ids: [candidate.id, ...ids.filter((id) => id !== candidate.id)] } : {}),
      ...(selection ? { selection } : {}),
    };
  } catch {
    return null;
  }
}

function parseSelection(value: unknown): TreeSelectionItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item): item is TreeSelectionItem => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as { kind?: unknown; id?: unknown };
    return (candidate.kind === "doc" || candidate.kind === "folder") &&
      typeof candidate.id === "string" && candidate.id.trim() !== "";
  });
  return items.length > 1 ? items : null;
}

export function writeTreeDragPayload(
  dataTransfer: TreeDragWriter,
  payload: DragPayload,
) {
  const encoded = JSON.stringify(payload);
  dataTransfer.effectAllowed = "move";
  dataTransfer.setData("text/plain", `${TREE_DRAG_TEXT_PREFIX}${encoded}`);
  try {
    dataTransfer.setData(TREE_DRAG_MIME, encoded);
  } catch {}
}

export function readTreeDragPayload(dataTransfer: TreeDragReader): DragPayload | null {
  try {
    const custom = parseTreeDragPayload(dataTransfer.getData(TREE_DRAG_MIME));
    if (custom) return custom;
  } catch {}

  try {
    const text = dataTransfer.getData("text/plain");
    if (!text.startsWith(TREE_DRAG_TEXT_PREFIX)) return null;
    return parseTreeDragPayload(text.slice(TREE_DRAG_TEXT_PREFIX.length));
  } catch {
    return null;
  }
}

export function hasExternalFileDrag(dataTransfer: Pick<DataTransfer, "files" | "types">): boolean {
  return dataTransfer.files.length > 0 || Array.from(dataTransfer.types).includes("Files");
}

export function markdownFilesFromDataTransfer(
  dataTransfer: Pick<DataTransfer, "files">,
): File[] {
  return Array.from(dataTransfer.files).filter((file) => /\.md$/i.test(file.name));
}
