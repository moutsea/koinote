import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

export const EDITOR_TAB_SELECTION_RESTORE_META =
  "koinote:tab-selection-restore";

export type EditorTabSelection = {
  anchor: number;
  head: number;
  focused: boolean;
};

export function captureEditorTabSelection(
  editor: Editor,
  focused = editor.isFocused,
): EditorTabSelection {
  const { anchor, head } = editor.state.selection;
  return {
    anchor,
    head,
    focused,
  };
}

export function shouldPreserveEditorFocusAfterBlur(
  activeElement: Element | null,
  body: HTMLElement | null,
): boolean {
  return activeElement === null || activeElement === body;
}

export function restoreEditorTabSelection(
  editor: Editor,
  selection: EditorTabSelection,
): boolean {
  if (editor.isDestroyed) return false;

  const maxPosition = editor.state.doc.content.size;
  const anchor = Math.min(Math.max(0, selection.anchor), maxPosition);
  const head = Math.min(Math.max(0, selection.head), maxPosition);
  const restored = TextSelection.between(
    editor.state.doc.resolve(anchor),
    editor.state.doc.resolve(head),
  );
  editor.view.dispatch(
    editor.state.tr
      .setSelection(restored)
      .setMeta("addToHistory", false)
      .setMeta(EDITOR_TAB_SELECTION_RESTORE_META, true),
  );
  if (selection.focused) editor.view.focus();
  return true;
}
