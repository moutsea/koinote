import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";

export function agentWorkspaceReadmeExtensions() {
  return [
    StarterKit.configure({ link: false, undoRedo: false }),
    Markdown.configure({ html: false, linkify: false }),
  ];
}
