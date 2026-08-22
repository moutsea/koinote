import type { Editor } from "@tiptap/core";
import { DESKTOP_IMAGE_MAPPING_META } from "../../desktop/offlineImagesCore";

export function applyUploadedImageMappingToEditor(
  editor: Editor,
  localURL: string,
  remoteURL: string,
): boolean {
  const selection = editor.state.selection;
  const transaction = editor.state.tr;
  let changed = false;

  editor.state.doc.descendants((node, position) => {
    if (node.type.name !== "image" || node.attrs.src !== localURL) return;
    transaction.setNodeMarkup(position, undefined, {
      ...node.attrs,
      src: remoteURL,
    });
    changed = true;
  });

  if (!changed) return false;
  editor.view.dispatch(
    transaction
      .setSelection(selection.map(transaction.doc, transaction.mapping))
      .setMeta("addToHistory", false)
      .setMeta(DESKTOP_IMAGE_MAPPING_META, true),
  );
  return true;
}
