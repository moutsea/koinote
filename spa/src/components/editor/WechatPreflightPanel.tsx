import { AlertTriangle, CheckCircle2, ChevronDown, Info } from "lucide-react";
import { interpolate, useI18n } from "../../i18n";
import { inspectWechatArticle, type WechatPreflightCheck } from "./wechatPreflight";

export function WechatPreflightPanel({ markdown, title }: { markdown: string; title: string }) {
  const { t } = useI18n();
  const result = inspectWechatArticle(markdown, title);
  const errors = result.checks.filter((check) => check.level === "error").length;
  const warnings = result.checks.filter((check) => check.level === "warning").length;
  const status = errors > 0 ? t.editor.wechatPreflight.blocked : t.editor.wechatPreflight.ready;

  return (
    <details className="mt-3 rounded-xl border border-black/10 dark:border-white/10">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-3 text-left [&::-webkit-details-marker]:hidden">
        {errors > 0 ? (
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        ) : (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-neutral-700 dark:text-neutral-200">
            {t.editor.wechatPreflight.title}
            <span className="ml-2 font-normal text-neutral-400">{status}</span>
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-neutral-400">
            {t.editor.wechatPreflight.summary}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400 transition-transform" />
      </summary>

      <div className="border-t border-black/10 px-3 pb-3 pt-3 dark:border-white/10">
        {result.metadata.hasFrontmatter && (
          <p className="mb-3 flex items-start gap-1.5 rounded-lg bg-blue-500/5 px-2.5 py-2 text-[11px] leading-relaxed text-blue-700 dark:text-blue-300">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t.editor.wechatPreflight.frontmatter}
          </p>
        )}

        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <Stat label={t.editor.wechatPreflight.metadata} value={result.metadata.title || "—"} />
          <Stat label={t.editor.wechatPreflight.structure} value={`${result.headings.length} H`} />
          <Stat label={t.editor.wechatPreflight.images} value={`${result.images.total}`} />
        </div>

        {result.checks.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {result.checks.map((check, index) => (
              <CheckRow key={`${check.code}-${index}`} check={check} imageCount={result.images.missingAlt} />
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-400">
          <span>{t.editor.wechatPreflight.copyTarget}: {result.readiness.copy ? t.editor.wechatPreflight.ready : t.editor.wechatPreflight.blocked}</span>
          <span>{t.editor.wechatPreflight.draftTarget}: {result.readiness.draft ? t.editor.wechatPreflight.ready : t.editor.wechatPreflight.blocked}</span>
          <span>{t.editor.wechatPreflight.images}: {result.images.remote} {t.editor.wechatPreflight.online} · {result.images.local} {t.editor.wechatPreflight.local}</span>
          {errors > 0 && <span>{errors} {t.editor.wechatPreflight.errorCount}</span>}
          {warnings > 0 && <span>{warnings} {t.editor.wechatPreflight.warningCount}</span>}
        </div>

        <div className="mt-3 rounded-lg bg-black/[0.025] px-2.5 py-2.5 dark:bg-white/[0.04]">
          <p className="text-[11px] font-semibold text-neutral-600 dark:text-neutral-300">
            {t.editor.wechatPreflight.advice}
          </p>
          {result.advice.length === 0 ? (
            <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">{t.editor.wechatPreflight.noAdvice}</p>
          ) : (
            <ul className="mt-1 space-y-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              {result.advice.map((code) => <li key={code}>· {adviceText(code)}</li>)}
            </ul>
          )}
        </div>
      </div>
    </details>
  );

  function adviceText(code: string): string {
    const advice = t.editor.wechatPreflight;
    switch (code) {
      case "toc": return advice.adviceToc;
      case "steps": return advice.adviceSteps;
      case "quote": return advice.adviceQuote;
      case "metrics": return advice.adviceMetrics;
      case "cover": return advice.adviceCover;
      case "cta": return advice.adviceCta;
      default: return code;
    }
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-black/[0.025] px-2.5 py-2 dark:bg-white/[0.04]">
      <span className="block truncate text-neutral-400">{label}</span>
      <span className="mt-0.5 block truncate font-medium text-neutral-700 dark:text-neutral-200">{value}</span>
    </div>
  );
}

function CheckRow({ check, imageCount }: { check: WechatPreflightCheck; imageCount: number }) {
  const { t } = useI18n();
  const icon = check.level === "error" ? <AlertTriangle className="h-3.5 w-3.5 text-red-500" /> : check.level === "warning" ? <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> : <Info className="h-3.5 w-3.5 text-blue-500" />;
  let message = check.message;
  const advice = t.editor.wechatPreflight;
  switch (check.code) {
    case "title_too_long": message = advice.checkTitleTooLong; break;
    case "title_missing": message = advice.checkTitleMissing; break;
    case "author_too_long": message = advice.checkAuthorTooLong; break;
    case "digest_too_long": message = advice.checkDigestTooLong; break;
    case "duplicate_title": message = advice.checkDuplicateTitle; break;
    case "title_mismatch": message = advice.checkTitleMismatch; break;
    case "image_alt_missing": message = interpolate(advice.checkImageAlt, { n: imageCount }); break;
    case "image_sync": message = advice.checkImageSync; break;
    case "module_unclosed":
    case "module_module_limit":
    case "module_module_not_found": message = advice.checkModuleError; break;
    default:
      if (check.code.startsWith("module_")) message = advice.checkModule;
  }
  return <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">{icon}<span>{message}</span></p>;
}
