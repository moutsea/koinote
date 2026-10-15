import { Link } from "@tanstack/react-router";
import { EditorContent, useEditor } from "@tiptap/react";
import { ArrowLeft } from "lucide-react";
import { useMemo } from "react";
import { InkClouds, PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { createEditorExtensions } from "../components/editor/extensions";
import { normalizeLegacyImageAdjacentHeadings } from "../components/editor/markdownImage";
import { shareContentClass } from "../components/editor/themeCss";
import { useI18n } from "../i18n";
import { CASE_ORIGINAL_MARKDOWN } from "../aiOptimizationCase";

export function AIOptimizationCasePage() {
  const { t } = useI18n();
  const guide = t.aiGuide;
  const extensions = useMemo(() => createEditorExtensions(""), []);
  const content = useMemo(
    () => normalizeLegacyImageAdjacentHeadings(CASE_ORIGINAL_MARKDOWN),
    [],
  );
  const editor = useEditor({
    extensions,
    editable: false,
    immediatelyRender: false,
    content,
    editorProps: { attributes: { class: shareContentClass("") } },
  });

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <InkClouds />
      <PageContainer className="relative flex-1 py-12 sm:py-16">
        <div className="mx-auto max-w-3xl">
          <Link
            to="/docs/ai-optimization"
            className="inline-flex items-center gap-2 text-sm font-medium transition hover:opacity-75"
            style={{ color: "var(--ink-mid)" }}
          >
            <ArrowLeft className="h-4 w-4" />
            {guide.caseOriginalBack}
          </Link>
          <header className="mt-8 border-b pb-6" style={{ borderColor: "var(--ink-line)" }}>
            <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--cinnabar)" }}>
              {guide.caseOriginalEyebrow}
            </p>
            <h1 className="kn-heading-cn mt-3 text-3xl font-bold sm:text-4xl" style={{ color: "var(--ink-black)" }}>
              {guide.caseOriginalTitle}
            </h1>
            <p className="mt-3 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>
              {guide.caseOriginalDescription}
            </p>
          </header>
          <PaperCard className="mt-8 p-6 sm:p-10">
            <EditorContent editor={editor} />
          </PaperCard>
        </div>
      </PageContainer>
    </div>
  );
}
