import Code from "@tiptap/extension-code";

export const InlineCode = Code.extend({
  addKeyboardShortcuts() {
    const parent = this.parent?.() ?? {};
    const wrapSelection = () => {
      if (this.editor.state.selection.empty) return false;
      return this.editor.commands.setCode();
    };

    return {
      ...parent,
      "`": wrapSelection,
    };
  },
});
