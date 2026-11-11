import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronLeft,
  Download,
  FileText,
  LoaderCircle,
  Search,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { confirmAction } from "../confirmAction";
import { ApiError } from "../api";
import {
  KOI_SKILLS_QUERY_KEY,
  deleteKoiSkill,
  cancelKoiImport,
  checkKoiSkillUpdate,
  getKoiSkill,
  getKoiSkillFile,
  koiErrorMessage,
  koiRequirementLabel,
  listKoiSkills,
  setKoiSkillEnabled,
  type KoiSkill,
  type KoiSkillFile,
  type KoiPreview,
} from "../koiSkills";
import { formatBytes } from "../storage";
import type { User } from "../api";
import { useI18n } from "../i18n";
import { PaperCard } from "./Ink";
import { KoiInstallDialog } from "./KoiInstallDialog";
import { KoiEmptyState, KoiPending, KoiRetry, KoiSkillSourceLabel, KoiSkillStatusBadge, useKoiSkillStorageInvalidation } from "./KoiSkillUi";

type StateFilter = "" | "enabled" | "disabled" | "unavailable";

export function KoiSkillsSection({ user, canInstall, onInstall }: {
 user: User; canInstall: boolean; onInstall: () => void;
}) {
  const { t, locale } = useI18n();
  const labels = t.koi;
  const userId = user.authUserId;
  const [search, setSearch] = useState("");
  const [state, setState] = useState<StateFilter>("");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Debounce text input so typing does not issue a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const page = useInfiniteQuery({
    queryKey: [KOI_SKILLS_QUERY_KEY, userId, query, state],
    queryFn: ({ pageParam }) => listKoiSkills({ q: query, state, cursor: pageParam }),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor || undefined,
  });
  const skills = useMemo(() => page.data?.pages.flatMap((item) => item.skills) ?? [], [page.data]);
  const invalidate = useKoiSkillStorageInvalidation(userId);
  const toggle = useMutation({
    onMutate: (): void => { remove.reset(); },
    mutationFn: (skill: KoiSkill) => setKoiSkillEnabled(skill.id, { expectedRevision: skill.revision, enabled: !skill.enabled }),
    onSettled: invalidate,
  });
  const remove = useMutation({
    onMutate: (): void => { toggle.reset(); },
    mutationFn: (skill: KoiSkill) => deleteKoiSkill(skill.id, skill.revision),
    onSuccess: () => setSelected(null),
    onSettled: invalidate,
  });

  if (selected) {
    return <KoiSkillDetail key={selected} id={selected} user={user} onBack={() => setSelected(null)} canInstall={canInstall} />;
  }
  const actionError = toggle.isError ? koiErrorMessage(toggle.error, labels) : remove.isError ? koiErrorMessage(remove.error, labels) : "";

  return (
    <section aria-labelledby="koi-skills-heading" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="koi-skills-heading" className="kn-heading-cn text-lg font-semibold" style={{ color: "var(--ink-black)" }}>{labels.skillsTitle}</h2>
          <p className="mt-1 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.skillsDescription}</p>
          {page.data && <p className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>{labels.skillStorageLabel} · {formatBytes(page.data.pages[0].storage.usedBytes, locale)}</p>}
        </div>
        {canInstall && (
          <button type="button" onClick={() => onInstall()} className="inline-flex shrink-0 items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-white" style={{ background: "var(--cinnabar)" }}>
            <Download className="h-4 w-4" />
            {labels.installSkill}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative block flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: "var(--ink-faint)" }} />
          <span className="sr-only">{labels.searchSkills}</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={labels.searchSkillsPlaceholder}
            className="w-full rounded-lg border bg-transparent py-2 pl-9 pr-3 text-sm"
            style={{ borderColor: "var(--ink-line)" }}
          />
        </label>
        <select value={state} onChange={(event) => setState(event.target.value as StateFilter)} aria-label={labels.filterState} className="rounded-lg border bg-transparent px-3 py-2 text-sm" style={{ borderColor: "var(--ink-line)" }}>
          <option value="">{labels.filterAllStates}</option>
          <option value="enabled">{labels.stateEnabled}</option>
          <option value="disabled">{labels.stateDisabled}</option>
          <option value="unavailable">{labels.stateUnavailable}</option>
        </select>
      </div>

      {actionError && <p role="alert" className="text-sm" style={{ color: "var(--cinnabar)" }}>{actionError}</p>}

      {page.isLoading ? <KoiPending label={labels.loading} /> : !page.data && page.isError ? (
        <KoiRetry label={labels.loadFailed} action={labels.retry} busy={page.isFetching} onRetry={() => void page.refetch()} />
      ) : skills.length === 0 ? (
        <KoiEmptyState
          canInstall={canInstall}
          onInstall={() => onInstall()}
          message={query || state ? labels.noMatches : labels.emptySkills}
        />
      ) : (
        <ul className="space-y-3">
          {skills.map((skill) => (
            <li key={skill.id}>
              <PaperCard className="p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <button type="button" onClick={() => setSelected(skill.id)} className="text-left text-sm font-semibold hover:underline" style={{ color: "var(--ink-black)" }}>
                      {skill.name}
                    </button>
                    <p className="mt-1 line-clamp-2 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{skill.description || labels.noDescription}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <KoiSkillSourceLabel source={skill.source} />
                      <span className="text-xs" style={{ color: "var(--ink-faint)" }}>{labels.versionLabel} {skill.version}</span>
                      <span className="text-xs" style={{ color: "var(--ink-faint)" }}>{formatBytes(skill.sizeBytes, locale)} · {labels.fileCount.replace("{count}", String(skill.fileCount))}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <KoiSkillStatusBadge state={!skill.compatibility.conversation ? "unavailable" : skill.enabled ? "enabled" : "disabled"} />
                    <label className="inline-flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        role="switch"
                        checked={skill.enabled}
                        disabled={toggle.isPending || remove.isPending || (!skill.enabled && (!skill.compatibility.conversation || !canInstall))}
                        aria-label={`${labels.enabledToggle} ${skill.name}`}
                        onChange={() => toggle.mutate(skill)}
                      />
                      {skill.enabled ? labels.stateEnabled : labels.stateDisabled}
                    </label>
                    <button
                      type="button"
                      className="rounded-md border p-1.5 disabled:opacity-50"
                      style={{ borderColor: "var(--ink-line)", color: "var(--ink-faint)" }}
                      aria-label={`${labels.uninstall} ${skill.name}`}
                      disabled={remove.isPending || toggle.isPending}
                      onClick={async () => {
                        if (await confirmAction(labels.uninstallConfirm.replace("{name}", skill.name))) remove.mutate(skill);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </PaperCard>
            </li>
          ))}
        </ul>
      )}
      {page.isFetchNextPageError && <KoiRetry label={labels.loadFailed} action={labels.retry} busy={page.isFetchingNextPage} onRetry={() => void page.fetchNextPage()} />}
      {page.hasNextPage && !page.isFetchNextPageError && (
        <button type="button" onClick={() => void page.fetchNextPage()} disabled={page.isFetchingNextPage} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm disabled:opacity-50" style={{ borderColor: "var(--ink-line)" }}>
          {page.isFetchingNextPage && <LoaderCircle className="h-4 w-4 animate-spin" />}
          {labels.loadMore}
        </button>
      )}
    </section>
  );
}

function KoiSkillDetail({ id, user, onBack, canInstall }: { id: string; user: User; onBack: () => void; canInstall: boolean }) {
  const { t, locale } = useI18n();
  const labels = t.koi;
  const userId = user.authUserId;
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updatePreview, setUpdatePreview] = useState<KoiPreview>();
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const check = useMutation({
    mutationFn: () => checkKoiSkillUpdate(id),
    onSuccess: (result) => {
      if (result.preview) {
        if (!active.current) { void cancelKoiImport(result.preview.id).catch(() => undefined); return; }
        setUpdatePreview(result.preview);
        setUpdateOpen(true);
      }
    },
  });
  const detailKey = [KOI_SKILLS_QUERY_KEY, userId, "detail", id];
  const detail = useQuery({ queryKey: detailKey, queryFn: () => getKoiSkill(id), enabled: Boolean(userId), retry: false });
  const client = useQueryClient();
  const invalidate = useKoiSkillStorageInvalidation(userId);
  const reconcile = async (removed = false) => {
    // A conflict or lost response can leave the server ahead of this view.
    // Keep actions pending until current state is read, without replaying writes.
    await invalidate();
    const error = client.getQueryState(detailKey)?.error;
    if (removed || (error instanceof ApiError && error.status === 404)) onBack();
  };
  const toggle = useMutation({
    onMutate: (): void => { remove.reset(); },
    mutationFn: (skill: KoiSkill) => setKoiSkillEnabled(skill.id, { expectedRevision: skill.revision, enabled: !skill.enabled }),
    onSettled: () => reconcile(),
  });
  const remove = useMutation({
    onMutate: (): void => { toggle.reset(); },
    mutationFn: (skill: KoiSkill) => deleteKoiSkill(skill.id, skill.revision),
    onSettled: (_result, error) => reconcile(!error),
  });
  const backButton = <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-medium hover:opacity-70" style={{ color: "var(--ink-mid)" }}>
    <ChevronLeft className="h-4 w-4" />
    {labels.backToSkills}
  </button>;
  if (detail.isLoading) return <KoiPending label={labels.loading} />;
  if (detail.isError || !detail.data) {
    return <section className="space-y-5">{backButton}<KoiRetry label={labels.loadFailed} action={labels.retry} busy={detail.isFetching} onRetry={() => void detail.refetch()} /></section>;
  }
  const { skill, files, instructions } = detail.data;
  const error = toggle.isError ? koiErrorMessage(toggle.error, labels) : remove.isError ? koiErrorMessage(remove.error, labels) : check.isError ? koiErrorMessage(check.error, labels) : "";
  const busy = toggle.isPending || remove.isPending || check.isPending || updateOpen;
  return (
    <section className="space-y-5">
      {backButton}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="kn-heading-cn text-xl font-semibold" style={{ color: "var(--ink-black)" }}>{skill.name}</h2>
          <p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{skill.description || labels.noDescription}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <KoiSkillSourceLabel source={skill.source} />
            <KoiSkillStatusBadge state={!skill.compatibility.conversation ? "unavailable" : skill.enabled ? "enabled" : "disabled"} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canInstall && <button type="button" disabled={busy} onClick={() => {
            check.reset(); toggle.reset(); remove.reset();
            if (skill.sourceKind === "folder") { setUpdatePreview(undefined); setUpdateOpen(true); }
            else check.mutate();
          }} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-50" style={{ borderColor: "var(--ink-line)" }}>
            <RefreshCw className={`h-3.5 w-3.5 ${check.isPending ? "animate-spin" : ""}`} />
            {skill.sourceKind === "folder" ? labels.uploadNewVersion : check.isPending ? labels.checkingUpdate : labels.checkUpdate}
          </button>}
          <label className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--ink-line)" }}>
            <input
              type="checkbox"
              role="switch"
              checked={skill.enabled}
              disabled={busy || (!skill.enabled && (!skill.compatibility.conversation || !canInstall))}
              onChange={() => toggle.mutate(skill)}
            />
            {labels.enabledToggle}
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={async () => { if (await confirmAction(labels.uninstallConfirm.replace("{name}", skill.name))) remove.mutate(skill); }}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-50"
            style={{ borderColor: "var(--cinnabar-soft)", color: "var(--cinnabar)" }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {labels.uninstall}
          </button>
        </div>
      </div>
      {error && <p role="alert" className="text-sm" style={{ color: "var(--cinnabar)" }}>{error}</p>}
      {check.data && !updateOpen && check.data.status !== "update_available" && <p role="status" className="text-sm" style={{ color: "var(--ink-mid)" }}>{check.data.status === "up_to_date" ? labels.upToDate : check.data.status === "source_unavailable" ? labels.sourceUnavailable : labels.manualOnly}</p>}
      <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <Fact label={labels.versionLabel} value={skill.version} />
        <Fact label={labels.filesLabel} value={String(skill.fileCount)} />
        <Fact label={labels.sizeLabel} value={formatBytes(skill.sizeBytes, locale)} />
        <Fact label={labels.installedLabel} value={new Date(skill.installedAt).toLocaleDateString(locale)} />
        <Fact label={labels.updatedLabel} value={new Date(skill.updatedAt).toLocaleDateString(locale)} />
        <Fact label={labels.licenseLabel} value={skill.license || labels.licenseNone} />
        <Fact label={labels.formatLabel} value={skill.metadataFormat === "plain-markdown" ? labels.formatPlain : labels.formatStandard} />
        <Fact label={labels.entryLabel} value={skill.entryPath} />
      </dl>

      {!skill.compatibility.conversation && (
        <PaperCard className="p-4">
          <p role="alert" className="flex items-start gap-2 text-sm" style={{ color: "var(--cinnabar)" }}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{labels.unavailableReason} {skill.compatibility.reasons.map((reason) => koiRequirementLabel(reason, labels)).join("; ") || "—"}</span>
          </p>
        </PaperCard>
      )}
      {skill.compatibility.warnings && skill.compatibility.warnings.length > 0 && (
        <p role="note" className="text-xs leading-5" style={{ color: "var(--ink-faint)" }}>
          {labels.warningsLabel} {skill.compatibility.warnings.map((warning) => koiRequirementLabel(warning, labels)).join("; ")}
        </p>
      )}

      <KoiSkillFiles key={`${skill.id}:${skill.versionId}`} user={user} skill={skill} files={files} instructions={instructions} />
      {updateOpen && canInstall && <KoiInstallDialog authUserId={userId} updateTarget={skill.sourceKind === "folder" ? skill : undefined} resumePreview={updatePreview} onClose={() => { setUpdateOpen(false); setUpdatePreview(undefined); check.reset(); void reconcile(); }} />}
    </section>
  );
}

function KoiSkillFiles({ user, skill, files, instructions }: { user: User; skill: KoiSkill; files: KoiSkillFile[]; instructions: string }) {
  const { t, locale } = useI18n();
  const labels = t.koi;
  const [position, setPosition] = useState<number | null>(null);
  const selected = files.find((file) => file.position === position);
  const attachment = selected && selected.path !== skill.entryPath ? selected : undefined;
  const preview = useQuery({
    queryKey: [KOI_SKILLS_QUERY_KEY, user.authUserId, "file", skill.id, skill.versionId, attachment?.position],
    queryFn: async () => {
      const result = await getKoiSkillFile(skill.id, attachment!.position, skill.versionId);
      if (result.file.sha256 !== attachment!.sha256 || result.file.path !== attachment!.path) throw new Error("File snapshot changed");
      const bytes = Uint8Array.from(atob(result.contentBase64), (char) => char.charCodeAt(0));
      try {
        return { text: bytes.includes(0) ? null : new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
      } catch { return { text: null }; }
    },
    enabled: Boolean(user && attachment), retry: false,
  });
  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
    <PaperCard className="min-w-0 p-4">
      <h3 className="flex items-start gap-2 break-all text-sm font-semibold" style={{ color: "var(--ink-strong)" }}><FileText className="mt-0.5 h-4 w-4 shrink-0" />{selected?.path ?? skill.entryPath}</h3>
      {attachment ? preview.isLoading ? <KoiPending label={labels.fileLoading} />
        : preview.isError ? <KoiRetry label={labels.fileLoadFailed} action={labels.retry} busy={preview.isFetching} onRetry={() => void preview.refetch()} />
          : preview.data?.text === null ? <p role="status" className="mt-3 text-xs leading-6" style={{ color: "var(--ink-mid)" }}>{labels.binaryFileNoPreview}</p>
            : <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words text-xs leading-6" style={{ color: "var(--ink-strong)" }}>{preview.data?.text}</pre>
        : <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words text-xs leading-6" style={{ color: "var(--ink-strong)" }}>{instructions}</pre>}
    </PaperCard>
    <PaperCard className="min-w-0 p-4">
      <h3 className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{labels.filesLabel}</h3>
      <ul className="mt-3 space-y-1.5 text-xs" style={{ color: "var(--ink-mid)" }}>{files.map((file) => <li key={file.position}>
        <button type="button" onClick={() => setPosition(file.position)} aria-pressed={selected ? selected.position === file.position : file.path === skill.entryPath} title={file.path} className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--paper-deep)] aria-pressed:font-semibold">
          <span className="truncate">{file.path}</span><span className="shrink-0" style={{ color: "var(--ink-faint)" }}>{formatBytes(file.sizeBytes, locale)}</span>
        </button>
      </li>)}</ul>
      <p className="mt-3 text-xs leading-5" style={{ color: "var(--ink-faint)" }}>{labels.packageReadOnly}</p>
    </PaperCard>
  </div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: "var(--ink-line)" }}>
      <dt style={{ color: "var(--ink-faint)" }}>{label}</dt>
      <dd className="mt-1 truncate font-medium" style={{ color: "var(--ink-strong)" }} title={value}>{value}</dd>
    </div>
  );
}
