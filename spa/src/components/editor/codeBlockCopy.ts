import { NodeSelection, type EditorState } from "@tiptap/pm/state";

export function selectedCodeBlockText(state: EditorState): string | null {
  const { selection } = state;
  if (selection instanceof NodeSelection) {
    return selection.node.type.name === "codeBlock"
      ? selection.node.textContent
      : null;
  }

  if (
    selection.empty ||
    selection.$from.parent.type.name !== "codeBlock" ||
    !selection.$from.sameParent(selection.$to)
  ) {
    return null;
  }

  return state.doc.textBetween(selection.from, selection.to, "\n", "\n");
}

export async function copyPlainText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("execCommand copy failed");
    }
  } finally {
    textarea.remove();
  }
}
