import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Activity, ArrowLeft, FileText, KeyRound, LoaderCircle } from "lucide-react";
import { listMCPActivity, type MCPActivity } from "../api";
import { useSession } from "../auth";
import { PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";

export function MCPActivityPage() {
  const session = useSession();
  const { t, locale } = useI18n();
  const [activities, setActivities] = useState<MCPActivity[]>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestSequence = useRef(0);
  const user = session.data?.user;

  async function load(cursor?: string) {
    const request = requestSequence.current + 1;
    requestSequence.current = request;
    setLoading(true);
    setFailed(false);
    try {
      const result = await listMCPActivity(cursor);
      if (requestSequence.current !== request) return;
      setActivities((current) => (cursor ? [...current, ...result.activities] : result.activities));
      setNextCursor(result.nextCursor);
    } catch {
      if (requestSequence.current !== request) return;
      setFailed(true);
    } finally {
      if (requestSequence.current === request) setLoading(false);
    }
  }

  useEffect(() => {
    requestSequence.current += 1;
    setActivities([]);
    setNextCursor("");
    setFailed(false);
    if (user?.membershipTier === "lifetime") void load();
    return () => {
      requestSequence.current += 1;
    };
  }, [user?.id, user?.membershipTier]);

  if (session.isLoading) {
    return <div className="flex flex-1 items-center justify-center py-24 text-sm" style={{ color: "var(--ink-faint)" }}>{t.dashboard.loading}</div>;
  }
  if (!user) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
        <p className="text-lg font-medium" style={{ color: "var(--ink-black)" }}>{t.dashboard.loginRequired}</p>
        <Link to="/login" className="rounded-full px-6 py-2.5 text-sm font-semibold text-white" style={{ background: "var(--cinnabar)" }}>{t.dashboard.goLogin}</Link>
      </div>
    );
  }

  return (
    <PageContainer className="flex-1 py-10">
      <Link to="/ai-settings" hash="mcp" className="inline-flex items-center gap-1.5 text-sm" style={{ color: "var(--ink-mid)" }}>
        <ArrowLeft className="h-4 w-4" />
        {t.mcpActivity.back}
      </Link>
      <div className="mt-5 flex items-start gap-3">
        <Activity className="mt-1 h-6 w-6" style={{ color: "var(--ink-faint)" }} />
        <div>
          <h1 className="kn-heading-cn text-2xl font-bold tracking-tight" style={{ color: "var(--ink-black)" }}>{t.mcpActivity.title}</h1>
          <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.mcpActivity.description}</p>
        </div>
      </div>

      {user.membershipTier !== "lifetime" ? (
        <PaperCard className="mt-8 p-6">
          <p className="text-sm" style={{ color: "var(--ink-mid)" }}>{t.mcpActivity.membersOnly}</p>
          <Link to="/pricing" className="mt-4 inline-flex rounded-full px-5 py-2.5 text-sm font-semibold" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{t.mcp.upgrade}</Link>
        </PaperCard>
      ) : activities.length === 0 && loading ? (
        <div className="flex items-center justify-center py-24 text-sm" style={{ color: "var(--ink-faint)" }}><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />{t.mcpActivity.loading}</div>
      ) : failed && activities.length === 0 ? (
        <PaperCard className="mt-8 p-6 text-center">
          <p className="text-sm" role="alert" style={{ color: "var(--ink-mid)" }}>{t.mcpActivity.loadFailed}</p>
          <button type="button" onClick={() => void load()} className="mt-4 rounded-full border px-4 py-2 text-sm" style={{ borderColor: "var(--ink-line)" }}>{t.mcpActivity.retry}</button>
        </PaperCard>
      ) : activities.length === 0 ? (
        <PaperCard className="mt-8 p-10 text-center text-sm">
          <p style={{ color: "var(--ink-mid)" }}>{t.mcpActivity.empty}</p>
        </PaperCard>
      ) : (
        <>
          <div className="mt-8 space-y-3">
            {activities.map((entry) => (
              <PaperCard key={entry.id} className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="rounded bg-[var(--ink-wash)] px-2 py-1 text-xs" style={{ color: "var(--ink-strong)" }}>{entry.toolName}</code>
                      <span className="text-xs font-medium" style={{ color: entry.result === "success" ? "var(--ink-mid)" : "var(--cinnabar)" }}>
                        {entry.result === "success" ? t.mcpActivity.success : t.mcpActivity.error}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs" style={{ color: "var(--ink-faint)" }}>
                      <span className="inline-flex items-center gap-1.5"><KeyRound className="h-3.5 w-3.5" />{entry.tokenName || t.mcpActivity.deletedToken}{entry.tokenHint ? ` ${entry.tokenHint}` : ""}</span>
                      {entry.docId && (entry.documentTitle ? (
                        <Link to="/editor/$docId" params={{ docId: entry.docId }} className="inline-flex items-center gap-1.5 hover:underline"><FileText className="h-3.5 w-3.5" />{entry.documentTitle}</Link>
                      ) : (
                        <span className="inline-flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" />{t.mcpActivity.deletedDocument} · {entry.docId}</span>
                      ))}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs" style={{ color: "var(--ink-faint)" }}>
                    <time>{entry.createdAt ? new Date(entry.createdAt).toLocaleString(locale) : "—"}</time>
                    <p className="mt-1">{entry.durationMs} ms</p>
                  </div>
                </div>
              </PaperCard>
            ))}
          </div>
          {(nextCursor || failed) && (
            <div className="mt-6 text-center">
              {failed && <p className="mb-3 text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>{t.mcpActivity.loadFailed}</p>}
              <button type="button" disabled={loading} onClick={() => void load(nextCursor)} className="inline-flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-medium disabled:opacity-60" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}>
                {loading && <LoaderCircle className="h-4 w-4 animate-spin" />}
                {failed ? t.mcpActivity.retry : t.mcpActivity.loadMore}
              </button>
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}
