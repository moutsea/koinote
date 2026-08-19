import { useEffect, useMemo, useRef } from "react";
import {
  BookOpenText,
  CalendarCheck2,
  CalendarDays,
  ClipboardList,
  CodeXml,
  Crown,
  FilePlus2,
  FileText,
  GitBranch,
  Lightbulb,
  LockKeyhole,
  Newspaper,
  UsersRound,
  X,
} from "lucide-react";

import {
  DOCUMENT_TEMPLATES,
  canUseDocumentTemplate,
  type DocumentTemplateCategory,
  type DocumentTemplateId,
} from "../documentTemplates";
import { useI18n } from "../i18n";

const CATEGORY_ORDER: readonly DocumentTemplateCategory[] = [
  "everyday",
  "writing",
  "product",
  "technical",
];

const TEMPLATE_ICONS: Record<DocumentTemplateId, typeof FileText> = {
  "meeting-notes": UsersRound,
  "daily-note": CalendarDays,
  "weekly-review": CalendarCheck2,
  "article-outline": Newspaper,
  "project-readme": BookOpenText,
  "product-requirements": ClipboardList,
  "research-paper": Lightbulb,
  "decision-record": GitBranch,
  "technical-design": CodeXml,
};

export function DocumentTemplateDialog({
  membershipTier,
  localMode,
  creating,
  createFailed,
  onCreate,
  onUpgrade,
  onClose,
}: {
  membershipTier: "free" | "lifetime";
  localMode: boolean;
  creating: boolean;
  createFailed: boolean;
  onCreate: (templateId: DocumentTemplateId | null) => void;
  onUpgrade: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const grouped = useMemo(
    () =>
      CATEGORY_ORDER.map((category) => ({
        category,
        templates: DOCUMENT_TEMPLATES.filter(
          (template) => template.category === category,
        ),
      })),
    [],
  );

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || creating) return;
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
      previousFocusRef.current?.focus();
    };
  }, [creating, onClose]);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-0 backdrop-blur-[2px] sm:p-5">
      <button
        type="button"
        aria-label={t.documentTemplates.close}
        disabled={creating}
        onClick={onClose}
        className="absolute inset-0 cursor-default disabled:pointer-events-none"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="document-template-title"
        className="relative flex h-full w-full flex-col overflow-hidden bg-white shadow-2xl dark:bg-neutral-950 sm:h-auto sm:max-h-[min(88vh,900px)] sm:max-w-5xl sm:rounded-2xl sm:border sm:border-black/10 dark:sm:border-white/10"
      >
        <header className="flex shrink-0 items-start gap-4 border-b px-5 py-4 sm:px-6 sm:py-5 dark:border-white/10">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cinnabar-600 dark:text-cinnabar-400">
              {t.documentTemplates.eyebrow}
            </p>
            <h2
              id="document-template-title"
              className="kn-heading-cn mt-1.5 text-xl font-bold text-neutral-950 dark:text-white sm:text-2xl"
            >
              {t.documentTemplates.title}
            </h2>
            <p className="mt-1.5 max-w-3xl text-sm leading-6 text-neutral-500 dark:text-neutral-400">
              {t.documentTemplates.subtitle}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            disabled={creating}
            onClick={onClose}
            aria-label={t.documentTemplates.close}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
          <button
            type="button"
            disabled={creating}
            onClick={() => onCreate(null)}
            className="group flex w-full items-center gap-4 rounded-xl border p-4 text-left transition hover:border-cinnabar-300 hover:bg-cinnabar-50/50 disabled:opacity-60 dark:border-white/10 dark:hover:border-cinnabar-700 dark:hover:bg-cinnabar-950/20"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-neutral-500 transition group-hover:bg-cinnabar-100 group-hover:text-cinnabar-700 dark:bg-white/10 dark:text-neutral-300 dark:group-hover:bg-cinnabar-950 dark:group-hover:text-cinnabar-300">
              <FilePlus2 className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-neutral-900 dark:text-white">
                {t.documentTemplates.blankTitle}
              </span>
              <span className="mt-1 block text-xs leading-5 text-neutral-500 dark:text-neutral-400">
                {t.documentTemplates.blankDescription}
              </span>
            </span>
            <span className="hidden rounded-full bg-neutral-100 px-2.5 py-1 text-[11px] font-semibold text-neutral-500 dark:bg-white/10 dark:text-neutral-300 sm:block">
              {t.documentTemplates.freeBadge}
            </span>
          </button>

          <div className="mt-6 space-y-7">
            {grouped.map(({ category, templates }) => (
              <section key={category} aria-labelledby={`template-${category}`}>
                <h3
                  id={`template-${category}`}
                  className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-neutral-400"
                >
                  {t.documentTemplates.categories[category]}
                </h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {templates.map((template) => {
                    const allowed = canUseDocumentTemplate(
                      template,
                      membershipTier,
                      localMode,
                    );
                    const locked = !allowed;
                    const Icon = TEMPLATE_ICONS[template.id];
                    const copy = t.documentTemplates.templates[template.id];
                    return (
                      <button
                        key={template.id}
                        type="button"
                        disabled={creating || (locked && localMode)}
                        onClick={() => {
                          if (allowed) onCreate(template.id);
                          else onUpgrade();
                        }}
                        className={`group relative min-h-36 rounded-xl border p-4 text-left transition disabled:opacity-60 ${
                          locked
                            ? "border-neutral-200 bg-neutral-50/70 hover:border-amber-300 dark:border-white/10 dark:bg-white/[0.025] dark:hover:border-amber-700"
                            : "hover:border-cinnabar-300 hover:bg-cinnabar-50/40 dark:border-white/10 dark:hover:border-cinnabar-700 dark:hover:bg-cinnabar-950/20"
                        }`}
                      >
                        <span
                          className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                            locked
                              ? "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
                              : "bg-neutral-100 text-neutral-500 group-hover:bg-cinnabar-100 group-hover:text-cinnabar-700 dark:bg-white/10 dark:text-neutral-300 dark:group-hover:bg-cinnabar-950 dark:group-hover:text-cinnabar-300"
                          }`}
                        >
                          {locked ? (
                            <LockKeyhole className="h-4 w-4" />
                          ) : (
                            <Icon className="h-4 w-4" />
                          )}
                        </span>
                        <span className="mt-3 flex items-start justify-between gap-2">
                          <span className="text-sm font-semibold text-neutral-900 dark:text-white">
                            {copy.name}
                          </span>
                          <span
                            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              template.tier === "lifetime"
                                ? "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
                                : "bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300"
                            }`}
                          >
                            {template.tier === "lifetime" && (
                              <Crown className="h-2.5 w-2.5" />
                            )}
                            {template.tier === "lifetime"
                              ? t.documentTemplates.memberBadge
                              : t.documentTemplates.freeBadge}
                          </span>
                        </span>
                        <span className="mt-1.5 block text-xs leading-5 text-neutral-500 dark:text-neutral-400">
                          {copy.description}
                        </span>
                        {locked && (
                          <span className="mt-3 block text-[11px] font-medium text-amber-700 dark:text-amber-300">
                            {localMode
                              ? t.documentTemplates.localModeLocked
                              : t.documentTemplates.upgradeHint}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          <p className="mt-7 text-center text-xs leading-5 text-neutral-400">
            {t.documentTemplates.sourceNote}
          </p>
          {createFailed && (
            <p
              role="alert"
              className="mt-3 text-center text-sm text-red-600 dark:text-red-400"
            >
              {t.documentTemplates.createFailed}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
