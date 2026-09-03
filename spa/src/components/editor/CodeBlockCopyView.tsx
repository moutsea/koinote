import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Copy, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { copyPlainText } from "./codeBlockCopy";

export function CodeBlockCopyView({ node }: NodeViewProps) {
  const { t } = useI18n();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    },
    [],
  );

  async function copyCode() {
    try {
      await copyPlainText(node.textContent);
      setCopyState("copied");
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = window.setTimeout(() => {
        setCopyState("idle");
        resetTimerRef.current = null;
      }, 1_800);
    } catch {
      setCopyState("failed");
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = window.setTimeout(() => {
        setCopyState("idle");
        resetTimerRef.current = null;
      }, 1_800);
    }
  }

  const language = typeof node.attrs.language === "string" ? node.attrs.language : "";
  const statusText =
    copyState === "copied"
      ? t.editor.codeBlockCopied
      : copyState === "failed"
        ? t.editor.codeBlockCopyFailed
        : "";

  return (
    <NodeViewWrapper as="pre" className="kn-code-block" style={{ position: "relative" }}>
      <NodeViewContent<"code">
        as="code"
        className={`kn-code-block-content${language ? ` language-${language}` : ""}`}
      />
      <button
        type="button"
        contentEditable={false}
        className="kn-code-block-copy"
        aria-label={
          copyState === "copied"
            ? t.editor.codeBlockCopied
            : copyState === "failed"
              ? t.editor.codeBlockCopyFailed
              : t.editor.codeBlockCopy
        }
        title={
          copyState === "copied"
            ? t.editor.codeBlockCopied
            : copyState === "failed"
              ? t.editor.codeBlockCopyFailed
              : t.editor.codeBlockCopy
        }
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void copyCode();
        }}
      >
        {copyState === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        <span>
          {copyState === "copied"
            ? t.editor.codeBlockCopied
            : copyState === "failed"
              ? t.editor.codeBlockCopyFailed
            : t.editor.codeBlockCopy}
        </span>
      </button>
      <span
        className="sr-only"
        role={copyState === "failed" ? "alert" : "status"}
        aria-live={copyState === "failed" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {statusText}
      </span>
    </NodeViewWrapper>
  );
}
