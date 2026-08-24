export type DragPayload =
  | { kind: "doc"; id: string }
  | { kind: "folder"; id: string };

export function sameTreeDragPayload(
  left: DragPayload | null | undefined,
  right: DragPayload | null | undefined,
): boolean {
  return Boolean(left && right && left.kind === right.kind && left.id === right.id);
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
    const candidate = parsed as { kind?: unknown; id?: unknown };
    if (candidate.kind !== "doc" && candidate.kind !== "folder") return null;
    if (typeof candidate.id !== "string" || candidate.id.trim() === "") return null;
    return { kind: candidate.kind, id: candidate.id };
  } catch {
    return null;
  }
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
