import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type InfiniteData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Check,
  FileText,
  ShieldCheck,
  ArrowUp,
  ChevronDown,
  History,
  Maximize2,
  Minimize2,
  Plus,
  Settings2,
  Square,
  X,
} from "lucide-react";
import "./AgentBottomPanel.css";
import { useI18n } from "../i18n";
import { agentPanelText } from "../i18n/agentPanel";
import { writingAgentText } from "../i18n/writingAgent";
import {
  getWritingConfig,
  getWritingTask,
  cancelWritingTask,
  applyWritingTask,
  writingFinished,
  type WritingTask,
} from "../writingAgent";
import { isDesktopRuntime } from "../desktop/runtime";
import { prepareDesktopSync } from "../desktop/logoutGuard";
import { AGENT_CREDITS_QUERY_KEY, fetchAppResource, ApiError } from "../api";
import { formatBytes } from "../storage";
import { STORAGE_USAGE_KEY } from "./StorageCard";
import { Logo } from "./Logo";
import { AgentDiffDialog } from "./AgentDiffDialog";
import { AgentProgress } from "./AgentProgress";
import { pushModal } from "../modalStack";
import {
  AGENT_PANEL_OPEN,
  actOnAgentOperation,
  actOnAgentOperationBatch,
  agentApprovalBatch,
  createAgentSession,
  deleteAgentSession,
  getAgentFocus,
  getAgentSession,
  getAgentSessionSettings,
  listAgentSessions,
  notifyAgentDocumentChange,
  readAgentPanelLayout,
  readAgentPanelLayoutSnapshot,
  saveAgentPanelLayout,
  sendAgentMessage,
  subscribeAgentFocus,
  updateAgentSession,
  updateAgentSessionSettings,
  type AgentOperation,
  type AgentPermission,
  type AgentSession,
  type AgentSessionPage,
} from "../agentSessions";
import { AgentRequestCache } from "../agentRequestCache";
import { AgentTaskReply } from "./AgentTaskReply";

const control = "agent-control disabled:cursor-not-allowed disabled:opacity-40";
const border = { borderColor: "var(--ink-line)" };
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const permissions: AgentPermission[] = ["review", "assist", "full"];
// A project-wide draft should stay detached even if the user switches articles.
const projectContext = "*";
// Local stand-in until the server returns the task; it never reaches the API.
const sendingProgress = { id: "sending", status: "preparing", cancelRequested: false } as const;

function AgentAvatar({ className = "" }: { className?: string }) {
  return (
    <span className={`agent-avatar ${className}`} aria-hidden="true">
      <Logo className="agent-avatar-mark" />
    </span>
  );
}
type AgentPanelProps = {
  accountKey: string;
  onOpenDocument?: (docId: string) => void;
};
type InitialAgentLayout = {
  saved: ReturnType<typeof readAgentPanelLayout>;
  restored: ReturnType<typeof readAgentPanelLayout>;
  sharedRaw: string | null;
  error: string;
};
type DraftSubmission = { draftId?: string; message: string; nextDraftId: string };
function readDraftSubmission(raw?: string): DraftSubmission | undefined {
  try {
    const value = JSON.parse(raw ?? "null");
    if (typeof value?.message === "string" && typeof value?.nextDraftId === "string" &&
      (value.draftId === undefined || typeof value.draftId === "string")) return value;
  } catch {}
}

export function AgentBottomPanel(props: AgentPanelProps) {
  const { accountKey } = props;
  const [bootstrap, setBootstrap] = useState<{
    accountKey: string; requests: AgentRequestCache; layout: InitialAgentLayout;
    openRequests: number; organizeRequest: number;
  } | null>(null);
  useEffect(() => {
    let mounted = true;
    let openRequests = 0;
    let organizeRequest = 0;
    // Keep listening throughout restoration and the handoff to the loaded UI.
    const open = (event: Event) => {
      const revision = ++openRequests;
      if ((event as CustomEvent).detail?.action === "organize") organizeRequest = revision;
      const request = { openRequests: revision, organizeRequest };
      setBootstrap((current) => current?.accountKey === accountKey
        ? { ...current, ...request } : current);
    };
    window.addEventListener(AGENT_PANEL_OPEN, open);
    const requests = new AgentRequestCache(accountKey);
    const snapshot = readAgentPanelLayoutSnapshot(accountKey);
    void (async () => {
      let pending = requests.pending();
      let error = "";
      try { pending = await requests.retainDraftRequests(snapshot.layout); }
      catch (cause) { error = errorMessage(cause); }
      const adjustments = Object.fromEntries(pending.flatMap(({ sessionId, draftId, input }) =>
        input.supersedeTaskId && draftId === snapshot.layout.draftIds[sessionId] &&
        input.message === snapshot.layout.drafts[sessionId]?.trim()
          ? [[sessionId, input.supersedeTaskId]] : [],
      ));
      if (mounted) setBootstrap({ accountKey, requests, openRequests, organizeRequest, layout: {
        saved: snapshot.layout, sharedRaw: snapshot.sharedRaw,
        restored: readAgentPanelLayout(accountKey, adjustments, snapshot), error,
      } });
    })();
    return () => {
      mounted = false;
      window.removeEventListener(AGENT_PANEL_OPEN, open);
    };
  }, [accountKey]);
  if (bootstrap?.accountKey !== accountKey) return null;
  return <LoadedAgentBottomPanel key={accountKey} {...props}
    requests={bootstrap.requests} initialLayout={bootstrap.layout}
    openRequests={bootstrap.openRequests} organizeRequest={bootstrap.organizeRequest} />;
}

function LoadedAgentBottomPanel({ accountKey, onOpenDocument, requests, initialLayout, openRequests, organizeRequest }:
  AgentPanelProps & { requests: AgentRequestCache; initialLayout: InitialAgentLayout; openRequests: number; organizeRequest: number }) {
  const { locale, t: strings } = useI18n();
  const t = agentPanelText[locale];
  const wt = writingAgentText[locale];
  const qc = useQueryClient();
  const [layout, setLayout] = useState(() => ({
    ...initialLayout.restored, open: initialLayout.restored.open || openRequests > 0,
  }));
  // Compare restored legacy fields against what was actually persisted, not
  // against their inferred values. Only migrate if no other window edited it.
  const previousLayout = useRef(initialLayout.saved);
  const initialLayoutSave = useRef(true);
  const [maximized, setMaximized] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("recent");
  const [error, setError] = useState(initialLayout.error);
  const [busy, setBusy] = useState(false);
  // Shown from the click until the accepted task is in the transcript, so the
  // document sync and request round trip are visible instead of a silent wait.
  const [sending, setSending] = useState<{
    sessionId: string;
    message: string;
    context?: { title: string; path: string };
    // Tasks shown before this send. A new task with the same message is this
    // one, even if a background refresh delivers it before the POST returns.
    before: ReadonlySet<string>;
    taskId?: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<AgentSession | null>(null);
  const [renaming, setRenaming] = useState<AgentSession | null>(null);
  useEffect(() => {
    if (deleting || renaming) return pushModal();
  }, [deleting, renaming]);
  const [rename, setRename] = useState("");
  const { ignored, adjusting } = layout;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const focus = useSyncExternalStore(
    subscribeAgentFocus,
    getAgentFocus,
    () => null,
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingInput = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const newSessionID = useRef("");
  const currentAccount = useRef(accountKey);
  const active = layout.active;
  const draft = layout.drafts[active] ?? "";
  const currentFocus = focus && ignored[active] !== projectContext && ignored[active] !== focus.path ? focus : null;

  useEffect(() => {
    composingInput.current = false;
  }, [active, layout.open]);

  useEffect(() => {
    void saveAgentPanelLayout(
      accountKey, layout, previousLayout.current,
      initialLayoutSave.current ? { sharedRaw: initialLayout.sharedRaw } : undefined,
    );
    previousLayout.current = layout;
    initialLayoutSave.current = false;
  }, [accountKey, layout]);
  useEffect(() => {
    currentAccount.current = accountKey;
    return () => {
      currentAccount.current = "";
    };
  }, [accountKey]);
  useEffect(() => {
    if (openRequests > 0) setLayout((s) => s.open ? s : { ...s, open: true });
  }, [openRequests]);
  const config = useQuery({
    queryKey: ["writing-config", accountKey],
    queryFn: getWritingConfig,
    staleTime: 60_000,
  });
  const defaults = useQuery({
    queryKey: ["agent-session-settings", accountKey],
    queryFn: getAgentSessionSettings,
  });
  const activity = useQuery({
    queryKey: ["agent-sessions", accountKey],
    queryFn: () => listAgentSessions(),
    refetchInterval: 3_000,
  });
  const history = useInfiniteQuery({
    queryKey: ["agent-session-history", accountKey, search, sort],
    queryFn: ({ pageParam }) => listAgentSessions(search, sort, pageParam),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor || undefined,
    enabled: layout.open && historyOpen,
  });
  const conversation = useInfiniteQuery({
    queryKey: ["agent-session", accountKey, active],
    queryFn: ({ pageParam }) => getAgentSession(active, pageParam),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor || undefined,
    enabled: !!active,
    refetchInterval: (query) =>
      query.state.data?.pages[0]?.tasks.some((task) => !writingFinished(task))
        ? 2_500
        : false,
  });
  const session = conversation.data?.pages[0]?.session;
  const tasks = useMemo(
    () =>
      [
        ...new Map(
          conversation.data?.pages
            .flatMap((page) => page.tasks)
            .map((task) => [task.id, task]) ?? [],
        ).values(),
      ].reverse(),
    [conversation.data],
  );
  const operations = useMemo(
    () => [
      ...new Map(
        conversation.data?.pages
          .flatMap((page) => page.operations)
          .map((op) => [op.id, op]) ?? [],
      ).values(),
    ],
    [conversation.data],
  );
  const artifacts =
    conversation.data?.pages.flatMap((page) => page.artifacts ?? []) ?? [];
  useEffect(() => {
    if (
      conversation.error instanceof ApiError &&
      conversation.error.status === 404 &&
      active
    ) {
      setLayout((state) => {
        const tabs = state.tabs.filter((id) => id !== active);
        return {
          ...state,
          tabs,
          active: state.active === active ? (tabs[0] ?? "") : state.active,
        };
      });
      qc.removeQueries({ queryKey: ["agent-session", accountKey, active] });
    }
  }, [conversation.error, active, accountKey, qc]);
  useEffect(() => {
    if (layout.open)
      requestAnimationFrame(() =>
        document
          .querySelector(
            '[data-agent-panel] [role="tab"][aria-selected="true"]',
          )
          ?.scrollIntoView({ inline: "nearest", block: "nearest" }),
      );
  }, [active, layout.open]);
  const running = tasks.find((task) => !writingFinished(task));
  const progress = useQuery({
    queryKey: ["agent-progress", accountKey, running?.id],
    queryFn: () => getWritingTask(running!.id),
    enabled: !!running,
    refetchInterval: 2_500,
  });
  const liveCounts =
    activity.data?.activity ??
    (activity.data?.sessions ?? []).reduce(
      (sum, item) => ({
        running: sum.running + item.activeTasks,
        pending: sum.pending + item.pendingOperations,
      }),
      { running: 0, pending: 0 },
    );
  const titles = new Map(
    [
      ...(activity.data?.sessions ?? []),
      ...(history.data?.pages.flatMap((page) => page.sessions) ?? []),
      ...(session ? [session] : []),
    ].map((item) => [item.id, item.title]),
  );
  const refreshAgentTree = useCallback(async () => {
    if (isDesktopRuntime()) {
      const { syncDesktopNow } = await import("../desktop/offlineStore");
      await syncDesktopNow({ force: true, pullOnly: true, strictPull: true });
    }
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["documents"] }),
      qc.invalidateQueries({ queryKey: ["folders"] }),
    ]);
  }, [qc]);
  const seenOperations = useRef(new Map<string, string>());
  useEffect(() => {
    let changed = false;
    for (const op of operations) {
      const old = seenOperations.current.get(op.id);
      seenOperations.current.set(op.id, op.status);
      if (
        (op.status === "applied" || op.status === "undone") &&
        old !== op.status
      ) {
        changed = true;
        if (op.result?.docId) notifyAgentDocumentChange(op.result.docId);
      }
    }
    if (changed) void refreshAgentTree().catch(() => setError(t.treeRefreshFailed));
  }, [operations, refreshAgentTree, t.treeRefreshFailed]);
  const activityFingerprint = (activity.data?.sessions ?? [])
    .map(
      (s) => `${s.id}:${s.updatedAt}:${s.activeTasks}:${s.pendingOperations}`,
    )
    .join("|");
  const previousActivity = useRef("");
  useEffect(() => {
    if (
      previousActivity.current &&
      previousActivity.current !== activityFingerprint
    ) {
      notifyAgentDocumentChange();
      if (active)
        void qc.invalidateQueries({
          queryKey: ["agent-session", accountKey, active],
        });
      void refreshAgentTree().catch(() => setError(t.treeRefreshFailed));
      void qc.invalidateQueries({ queryKey: STORAGE_USAGE_KEY });
      void qc.invalidateQueries({ queryKey: AGENT_CREDITS_QUERY_KEY });
    }
    previousActivity.current = activityFingerprint;
  }, [activityFingerprint, qc, active, accountKey, refreshAgentTree, t.treeRefreshFailed]);
  useEffect(() => {
    setSelected(new Set());
    setError("");
    nearBottom.current = false;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        const stored = layout.scroll[active];
        scrollRef.current.scrollTop = stored ?? scrollRef.current.scrollHeight;
        nearBottom.current =
          stored === undefined ||
          scrollRef.current.scrollHeight -
            scrollRef.current.scrollTop -
            scrollRef.current.clientHeight <
            80;
      }
    });
  }, [active]);
  const transcriptKey =
    tasks
      .map((task) => `${task.id}:${task.status}:${task.result.length}`)
      .join("|") + operations.map((op) => op.status).join();
  useEffect(() => {
    if (nearBottom.current && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [transcriptKey]);
  // Follow a send only in its own tab. The transcript element is shared, so a
  // reply for a tab the user left must not move the tab they are reading.
  const sendingHere = sending?.sessionId === active;
  useEffect(() => {
    if (sendingHere && scrollRef.current) {
      nearBottom.current = true;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [sendingHere]);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["agent-session", accountKey] }),
      qc.invalidateQueries({ queryKey: ["agent-sessions", accountKey] }),
      qc.invalidateQueries({ queryKey: ["agent-session-history", accountKey] }),
      qc.invalidateQueries({ queryKey: STORAGE_USAGE_KEY }),
      qc.invalidateQueries({ queryKey: AGENT_CREDITS_QUERY_KEY }),
    ]);
  };
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (currentAccount.current === accountKey) setError(errorMessage(e));
    } finally {
      if (currentAccount.current === accountKey) setBusy(false);
    }
  };
  const openSession = (id: string) => {
    setLayout((s) => ({
      ...s,
      open: true,
      active: id,
      tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id],
    }));
    setHistoryOpen(false);
  };
  const closeTab = (id: string) =>
    setLayout((s) => {
      const tabs = s.tabs.filter((tab) => tab !== id);
      return {
        ...s,
        tabs,
        active:
          s.active === id
            ? (tabs[Math.max(0, s.tabs.indexOf(id) - 1)] ?? tabs[0] ?? "")
            : s.active,
      };
    });
  const setDraft = (id: string, value: string) => {
    setLayout((s) => {
      const submitted = readDraftSubmission(s.draftSubmissions[id]);
      let draftIds = s.draftIds;
      let draftSubmissions = s.draftSubmissions;
      // Clearing explicitly ends the retry/edit relationship. Nonempty edits
      // retain it until acknowledgement, including across errors and reloads.
      if (!value.trim()) {
        draftSubmissions = { ...draftSubmissions };
        delete draftSubmissions[id];
      } else if (!s.drafts[id]?.trim()) {
        draftIds = { ...draftIds, [id]: crypto.randomUUID() };
      } else if (submitted &&
        (s.draftIds[id] === submitted.draftId || s.draftIds[id] === submitted.nextDraftId)) {
        const restoredId = value.trim() === submitted.message
          ? submitted.draftId : submitted.nextDraftId;
        draftIds = { ...draftIds };
        if (restoredId === undefined) delete draftIds[id];
        else draftIds[id] = restoredId;
      }
      return { ...s, drafts: { ...s.drafts, [id]: value }, draftIds, draftSubmissions };
    });
  };
  const newSession = (organize = false) =>
    perform(async () => {
      newSessionID.current ||= crypto.randomUUID();
      const created = await createAgentSession(newSessionID.current);
      newSessionID.current = "";
      if (currentAccount.current !== accountKey) return;
      const id = created.session.id;
      qc.setQueryData(["agent-session", accountKey, id], { pages: [created], pageParams: [""] });
      openSession(id);
      if (organize) {
        setDraft(id, t.starterOrganizePrompt);
        setLayout((s) => ({ ...s, ignored: { ...s.ignored, [id]: projectContext } }));
      }
      requestAnimationFrame(() => inputRef.current?.focus());
      await refresh();
    });
  const handledOrganizerRequest = useRef(0);
  useEffect(() => {
    if (organizeRequest === handledOrganizerRequest.current || busy) return;
    handledOrganizerRequest.current = organizeRequest;
    setHistoryOpen(false);
    setSettingsOpen(false);
    const existing = layout.tabs.find((id) => layout.ignored[id] === projectContext &&
      layout.drafts[id] === t.starterOrganizePrompt && !layout.draftSubmissions[id]);
    if (existing) {
      openSession(existing);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      void newSession(true);
    }
  }, [organizeRequest, busy, layout, newSession, t.starterOrganizePrompt]);
  const send = () =>
    perform(async () => {
      const id = active;
      const message = draft.trim();
      const draftId = layout.draftIds[id];
      const capturedFocus = currentFocus;
      const supersedeTaskId = adjusting[id];
      if (!id || !message || running) return;
      setSending({
        sessionId: id,
        message,
        before: new Set(tasks.map((task) => task.id)),
        ...(capturedFocus ? { context: { title: capturedFocus.title, path: capturedFocus.path } } : {}),
      });
      try {
        const previousSubmission = readDraftSubmission(layout.draftSubmissions[id]);
        const submitted: DraftSubmission = previousSubmission && previousSubmission.draftId === draftId &&
          previousSubmission.message === message ? previousSubmission : {
            draftId, message, nextDraftId: crypto.randomUUID(),
          };
        setLayout((s) => ({ ...s, draftSubmissions: {
          ...s.draftSubmissions, [id]: JSON.stringify(submitted),
        } }));
        if (capturedFocus && !(await capturedFocus.prepare()))
          throw new Error(t.draftChanged);
        if ((ignored[id] === projectContext && !tasks.length) || message === t.starterOrganizePrompt) {
          const l = strings.editor.aiOrganizer;
          if (isDesktopRuntime()) {
            const { desktopPrepareLibraryForOrganization } = await import("../desktop/offlineStore");
            const conflicts = await desktopPrepareLibraryForOrganization().catch((cause) => {
              throw new Error(errorMessage(cause) === "organization_folder_sync_conflict" ? l.folderSyncConflict : l.saveFailed);
            });
            if (conflicts.length) throw new Error(l.syncConflict);
          } else if (!(await prepareDesktopSync())) throw new Error(l.saveFailed);
        }
        if (currentAccount.current !== accountKey) return;
        const payload = {
          message,
          ...(capturedFocus
            ? {
                context: { title: capturedFocus.title, path: capturedFocus.path },
              }
            : {}),
          skillRepositoryId: 0,
          skillPath: "",
          ...(supersedeTaskId ? { supersedeTaskId } : {}),
        };
        const pending = await requests.prepare(id, payload, draftId, { automaticSkills: true });
        if (currentAccount.current !== accountKey) return;
        const { task: accepted } = await sendAgentMessage(id, pending.input);
        // An unmounted account still has its submitted draft in browser storage.
        // Keep its request ID so a remount can retry without creating another task;
        // a late response must also never overwrite the new instance's requests.
        if (currentAccount.current !== accountKey) return;
        // Show the accepted task now; the refresh below only adds server detail.
        setSending((s) => s && { ...s, taskId: accepted.id });
        qc.setQueryData<InfiniteData<AgentSessionPage>>(
          ["agent-session", accountKey, id],
          (data) => {
            const first = data?.pages[0];
            if (!first || data.pages.some((page) => page.tasks.some((task) => task.id === accepted.id)))
              return data;
            return { ...data, pages: [{ ...first, tasks: [accepted, ...first.tasks] }, ...data.pages.slice(1)] };
          },
        );
        await requests.complete(pending);
        if (currentAccount.current !== accountKey) return;
        setLayout((s) => {
          const draftSubmissions = { ...s.draftSubmissions };
          if (readDraftSubmission(draftSubmissions[id])?.nextDraftId === submitted.nextDraftId)
            delete draftSubmissions[id];
          // Acknowledgement ends this edit lineage, but keeps any queued text.
          if (s.draftIds[id] !== draftId || s.drafts[id]?.trim() !== message)
            return { ...s, draftSubmissions };
          const nextAdjusting = { ...s.adjusting };
          const nextDraftIds = { ...s.draftIds };
          delete nextDraftIds[id];
          if (nextAdjusting[id] === supersedeTaskId) delete nextAdjusting[id];
          return {
            ...s,
            drafts: {
              ...s.drafts,
              [id]: "",
            },
            adjusting: nextAdjusting,
            draftIds: nextDraftIds,
            draftSubmissions,
          };
        });
        await refresh();
      } finally {
        if (currentAccount.current === accountKey) setSending(null);
      }
    });
  const act = (op: AgentOperation, action: "approve" | "reject" | "undo") =>
    perform(async () => {
      await actOnAgentOperation(op, action);
      await refresh();
    });
  const changePermission = (permission: AgentPermission) =>
    perform(async () => {
      if (!session) return;
      await updateAgentSession(session.id, {
        permission,
        revision: session.revision,
      });
      await refresh();
    });
  const permissionHelp =
    session?.permission === "full"
      ? t.fullHelp
      : session?.permission === "assist"
        ? t.approvalHelp
        : t.reviewHelp;

  return (
    <section
      data-agent-panel
      className={`agent-panel sticky bottom-0 z-30 flex shrink-0 flex-col border-t ${layout.open ? "agent-panel-open" : ""}`}
      style={{
        ...border,
        background: "var(--ink-paper)",
        color: "var(--ink-strong)",
      }}
    >
      {layout.open && (
        <div
          className="flex min-h-0 flex-col"
          style={{
            height: maximized
              ? "calc(100dvh - 100px)"
              : `min(${layout.height}px, calc(100dvh - 120px))`,
            minHeight: 220,
          }}
        >
          <div
            role="separator"
            aria-label={t.resize}
            aria-orientation="horizontal"
            aria-valuenow={layout.height}
            aria-valuemin={220}
            aria-valuemax={800}
            tabIndex={0}
            className="agent-resizer absolute -top-1 left-0 h-2 w-full cursor-row-resize touch-none"
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                setLayout((s) => ({
                  ...s,
                  height: Math.max(
                    220,
                    Math.min(800, s.height + (e.key === "ArrowUp" ? 20 : -20)),
                  ),
                }));
              }
            }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              e.currentTarget.dataset.startY = String(e.clientY);
              e.currentTarget.dataset.startHeight = String(layout.height);
              setMaximized(false);
            }}
            onPointerMove={(e) => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
              const height =
                Number(e.currentTarget.dataset.startHeight) +
                Number(e.currentTarget.dataset.startY) -
                e.clientY;
              setLayout((s) => ({
                ...s,
                height: Math.max(220, Math.min(800, height)),
              }));
            }}
            onPointerUp={(e) =>
              e.currentTarget.releasePointerCapture(e.pointerId)
            }
          />
          <div
            className="agent-toolbar flex shrink-0 items-center border-b"
            style={border}
          >
            <div className="agent-brand">
              <AgentAvatar />
              <span>{t.assistantName}</span>
              <span className="agent-ai-label">AI</span>
            </div>
            <div
              role="tablist"
              aria-label={t.assistantName}
              className="agent-tabs flex min-w-0 flex-1 overflow-x-auto"
            >
              {layout.tabs.map((id) => (
                <div
                  key={id}
                  className={`agent-tab flex shrink-0 items-center ${id === active ? "is-active" : ""}`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={id === active}
                    className="agent-tab-label max-w-48 truncate"
                    onClick={() => openSession(id)}
                  >
                    {titles.get(id) ?? t.newSession}
                  </button>
                  <button
                    type="button"
                    aria-label={`${t.closeTab}: ${titles.get(id) ?? ""}`}
                    className="agent-tab-close"
                    onClick={() => closeTab(id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className={control}
              title={t.newSession}
              aria-label={t.newSession}
              onClick={() => void newSession()}
              disabled={busy}
            >
              <Plus size={15} />
            </button>
            <button
              type="button"
              className={control}
              title={t.history}
              aria-label={t.history}
              aria-pressed={historyOpen}
              onClick={() => setHistoryOpen(!historyOpen)}
            >
              <History size={15} />
            </button>
            <button
              type="button"
              className={control}
              title={t.settings}
              aria-label={t.settings}
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen(!settingsOpen)}
            >
              <Settings2 size={15} />
            </button>
            <button
              type="button"
              className={control}
              title={maximized ? t.restore : t.maximize}
              aria-label={maximized ? t.restore : t.maximize}
              onClick={() => setMaximized(!maximized)}
            >
              {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <button
              type="button"
              className={control}
              title={t.hide}
              aria-label={t.hide}
              onClick={() => setLayout((s) => ({ ...s, open: false }))}
            >
              <ChevronDown size={16} />
            </button>
          </div>
          {settingsOpen && (
            <div
              className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-xs"
              style={border}
            >
              <label>
                {t.defaults}{" "}
                <select
                  aria-label={t.defaults}
                  value={defaults.data?.permission ?? "review"}
                  disabled={busy}
                  className="rounded border bg-[var(--ink-paper)] p-1"
                  onChange={(e) =>
                    void perform(async () => {
                      await updateAgentSessionSettings(
                        e.target.value as AgentPermission,
                      );
                      await qc.invalidateQueries({
                        queryKey: ["agent-session-settings", accountKey],
                      });
                    })
                  }
                >
                  {permissions.map((mode) => (
                    <option key={mode} value={mode}>
                      {t[mode]}
                    </option>
                  ))}
                </select>
              </label>
              <span style={{ color: "var(--ink-faint)" }}>{t.unsent}</span>
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="flex shrink-0 items-center justify-between gap-2 bg-red-50 px-4 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200"
            >
              <span>{error}</span>
              <button
                type="button"
                aria-label={wt.close}
                onClick={() => setError("")}
              >
                <X size={14} />
              </button>
            </div>
          )}
          <div className="flex min-h-0 flex-1">
            {historyOpen && (
              <aside
                aria-label={t.history}
                className="agent-history flex w-full shrink-0 flex-col gap-2 overflow-y-auto border-r p-4 sm:w-72"
                style={border}
              >
                <p className="agent-section-label">{t.history}</p>
                <input
                  aria-label={t.search}
                  placeholder={t.search}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full rounded border bg-transparent px-2 py-1 text-xs"
                  style={border}
                />
                <select
                  aria-label={t.size}
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                  className="rounded bg-[var(--ink-paper)] text-xs"
                >
                  <option value="recent">{t.recent}</option>
                  <option value="size">{t.size}</option>
                </select>
                {history.isError && (
                  <button
                    className={control}
                    onClick={() => void history.refetch()}
                  >
                    {t.reload}
                  </button>
                )}
                {history.data?.pages
                  .flatMap((page) => page.sessions)
                  .map((item) => (
                    <div
                      key={item.id}
                      className={`agent-history-item ${item.id === active ? "is-active" : ""}`}
                      style={border}
                    >
                      <button
                        type="button"
                        className="w-full truncate text-left text-sm"
                        onClick={() => openSession(item.id)}
                      >
                        {item.title}
                      </button>
                      <p
                        className="mt-1 text-[11px]"
                        style={{ color: "var(--ink-faint)" }}
                      >
                        {formatBytes(item.usedBytes, locale)} ·{" "}
                        {new Date(item.updatedAt).toLocaleDateString(locale)}{" "}
                        {item.activeTasks > 0
                          ? `· ${t.running}`
                          : item.pendingOperations > 0
                            ? `· ${t.pending}`
                            : ""}
                      </p>
                      <div className="mt-1 flex">
                        <button
                          type="button"
                          className={control}
                          onClick={() => {
                            setRenaming(item);
                            setRename(item.title);
                          }}
                        >
                          {t.rename}
                        </button>
                        <button
                          type="button"
                          className={control}
                          onClick={() => setDeleting(item)}
                        >
                          {t.delete}
                        </button>
                      </div>
                    </div>
                  ))}
                {history.hasNextPage && (
                  <button
                    type="button"
                    className={control}
                    disabled={history.isFetchingNextPage}
                    onClick={() => void history.fetchNextPage()}
                  >
                    {t.more}
                  </button>
                )}
              </aside>
            )}
            <div
              className={`${historyOpen ? "hidden sm:flex" : "flex"} min-w-0 flex-1 flex-col`}
            >
              <div
                ref={scrollRef}
                role="tabpanel"
                className="agent-transcript min-h-0 flex-1 overflow-y-auto overscroll-contain"
                onScroll={(e) => {
                  const node = e.currentTarget;
                  nearBottom.current =
                    node.scrollHeight - node.scrollTop - node.clientHeight < 80;
                  if (active)
                    setLayout((s) => ({
                      ...s,
                      scroll: { ...s.scroll, [active]: node.scrollTop },
                    }));
                }}
              >
                {!active && (
                  <div
                    className="agent-welcome flex h-full flex-col items-center justify-center gap-3 text-sm"
                    style={{ color: "var(--ink-mid)" }}
                  >
                    <AgentAvatar className="agent-avatar-welcome" />
                    <h2>{t.welcomeTitle}</h2>
                    <p>{t.noSession}</p>
                    <button
                      type="button"
                      className={`${control} agent-primary`}
                      style={border}
                      onClick={() => void newSession()}
                      disabled={busy}
                    >
                      {t.newSession}
                    </button>
                  </div>
                )}
                {active && conversation.isError && (
                  <div role="alert" className="text-sm">
                    <p>{errorMessage(conversation.error)}</p>
                    <button
                      type="button"
                      className={control}
                      onClick={() => void conversation.refetch()}
                    >
                      {t.reload}
                    </button>
                  </div>
                )}
                {active && conversation.isPending && (
                  <p className="text-xs">{wt.loading}</p>
                )}
                {session && tasks.length === 0 && (
                  <div className="agent-welcome agent-welcome-session">
                    <AgentAvatar className="agent-avatar-welcome" />
                    <h2>{t.welcomeTitle}</h2>
                    <p>{t.empty}</p>
                    <div className="agent-starters">
                      {[t.starterPolish, t.starterDraft, t.starterOrganize].map(
                        (text) => (
                          <button
                            type="button"
                            className={control}
                            key={text}
                            onClick={() => {
                              setDraft(active, text === t.starterOrganize ? t.starterOrganizePrompt : text);
                              inputRef.current?.focus();
                            }}
                          >
                            {text}
                            <ArrowUp size={13} />
                          </button>
                        ),
                      )}
                    </div>
                  </div>
                )}
                {conversation.hasNextPage && (
                  <button
                    type="button"
                    className={control}
                    disabled={conversation.isFetchingNextPage}
                    onClick={() => {
                      nearBottom.current = false;
                      void conversation.fetchNextPage();
                    }}
                  >
                    {t.older}
                  </button>
                )}
                {tasks.map((task) => (
                  <article key={task.id} className="agent-turn mx-auto text-sm">
                    <div className="agent-user-message ml-auto w-fit">
                      <p className="whitespace-pre-wrap break-words">
                        {task.message}
                      </p>
                      {task.source.path && (
                        <p
                          className="agent-message-context"
                          title={task.source.path}
                          style={{ color: "var(--ink-faint)" }}
                        >
                          {t.taskContext}: {task.source.title}
                        </p>
                      )}
                    </div>
                    <div className="agent-reply">
                      <div className="agent-reply-content">
                        <div className="agent-reply-name">
                          <AgentAvatar className="agent-reply-avatar" />
                          {t.assistantName}
                          <span>{t.writingPartner}</span>
                        </div>
                        <AgentTaskReply task={task} operations={operations} />
                        {artifacts
                          .filter((file) => file.taskId === task.id)
                          .map((file) => (
                            <button
                              type="button"
                              key={file.id}
                              className={`${control} mr-2 border`}
                              style={border}
                              disabled={busy}
                              onClick={() =>
                                void perform(async () => {
                                  const response = await fetchAppResource(
                                    `/api/agent/artifacts/${file.id}`,
                                    { credentials: "include" },
                                  );
                                  if (!response.ok) throw new Error(wt.failed);
                                  const { saveExportBlob, safeFilename } =
                                    await import("./editor/exportDocument");
                                  const name = safeFilename(
                                    file.name,
                                    "agent-result.txt",
                                  );
                                  await saveExportBlob(
                                    await response.blob(),
                                    name,
                                    name.split(".").pop() || "txt",
                                  );
                                })
                              }
                            >
                              ↓ {file.name} · {formatBytes(file.bytes, locale)}
                            </button>
                          ))}
                        {task.proposal && (
                          <LegacyProposal
                            task={task}
                            busy={busy}
                            error={error}
                            onApply={() =>
                              void perform(async () => {
                                const { document } =
                                  await applyWritingTask(task);
                                notifyAgentDocumentChange(document.docId);
                                await qc.invalidateQueries({
                                  queryKey: ["documents"],
                                });
                                await refresh();
                              })
                            }
                          />
                        )}
                        {task.error && (
                          <p
                            role="alert"
                            className="text-xs text-red-700 dark:text-red-300"
                          >
                            {task.error}
                          </p>
                        )}
                        {agentApprovalBatch(operations, task.id).length > 0 && (
                          <section className="agent-proposal" style={border} data-approval-task={task.id}>
                            <p className="font-medium">{t.approvalBatch} · {operations.filter((op) => op.taskId === task.id && op.status === "pending").length}</p>
                            <p className="text-xs" role="status">{task.status === "awaiting_approval" ? t.waitingApproval : writingFinished(task) ? t.reviewHelp : t.preparingApproval}</p>
                            {operations.filter((op) => op.taskId === task.id && op.status === "pending").map((op) => (
                              (op.input.kind === "folder" || op.input.kind === "delete_folder") ? (
                                <div key={op.id} data-operation-id={op.id} className="flex items-center justify-between gap-3 border-b py-2 text-sm" style={border}>
                                  <span>{op.before?.folder?.name || op.input.title}</span><span className="text-xs" style={{ color: "var(--ink-faint)" }}>{t[op.input.kind]}</span>
                                </div>
                              ) : <OperationCard key={op.id} operation={op} grouped busy={busy} error={error} selected={false}
                                onSelect={() => {}} onAction={() => {}} onAdjust={() => {}}
                                onOpenDocument={onOpenDocument ? (docId) => {
                                  setMaximized(false);
                                  setLayout((old) => ({ ...old, open: false }));
                                  onOpenDocument(docId);
                                } : undefined} />
                            ))}
                            <div className="agent-proposal-actions flex flex-wrap gap-2">
                              {(["approve", "reject"] as const).map((action) => (
                                <button key={action} type="button" className={`${control} ${action === "approve" ? "agent-primary" : ""}`}
                                  disabled={busy || (!writingFinished(task) && task.status !== "awaiting_approval")}
                                  onClick={() => void perform(async () => {
                                    const batch = operations.filter((op) => op.taskId === task.id && op.status === "pending");
                                    await actOnAgentOperationBatch(task.id, batch, action);
                                    setSelected((old) => new Set([...old].filter((id) => !batch.some((op) => op.id === id))));
                                    await refresh();
                                  })}>
                                  {action === "approve" ? (writingFinished(task) ? t.approve : t.approveBatch) : t.rejectBatch}
                                </button>
                              ))}
                            </div>
                          </section>
                        )}
                        {operations.some((op) => op.taskId === task.id && op.input.kind === "delete_folder" && op.status === "applied") && (
                          <button type="button" className={control} disabled={busy}
                            data-undo-folder-task={task.id}
                            onClick={() => void perform(async () => {
                              await actOnAgentOperationBatch(task.id, operations.filter((op) => op.taskId === task.id && op.input.kind === "delete_folder" && op.status === "applied"), "undo");
                              await refresh();
                            })}>{t.undoFolderBatch}</button>
                        )}
                        {operations
                          .filter((op) => op.taskId === task.id && !agentApprovalBatch(operations, task.id).some((pending) => pending.id === op.id))
                          .map((op) => (
                            <OperationCard
                              key={op.id}
                              operation={op}
                              busy={busy}
                              error={error}
                              selected={selected.has(op.id)}
                              onSelect={() =>
                                setSelected((old) => {
                                  const next = new Set(old);
                                  if (next.has(op.id)) next.delete(op.id);
                                  else next.add(op.id);
                                  return next;
                                })
                              }
                              onAction={(action) => act(op, action)}
                              onOpenDocument={onOpenDocument ? (docId) => {
                                setMaximized(false);
                                setLayout((old) => ({ ...old, open: false }));
                                onOpenDocument(docId);
                              } : undefined}
                              onAdjust={() => {
                                setLayout((old) => ({
                                  ...old,
                                  adjusting: {
                                    ...old.adjusting,
                                    [active]: task.id,
                                  },
                                }));
                                inputRef.current?.focus();
                              }}
                            />
                          ))}
                        <p
                          className="agent-task-meta"
                          style={{ color: "var(--ink-faint)" }}
                        >
                          {task.cancelRequested && !writingFinished(task)
                            ? wt.cancelling
                            : task.status === "failed"
                              ? wt.taskFailed
                              : task.taskIntent?.outcome === "clarification_required"
                                ? wt.clarificationRequired
                                : task.taskIntent?.outcome === "partial"
                                  ? wt.partial
                                  : wt[task.status]}{" "}
                          ·{" "}
                          {task.billingStatus === "needs_review"
                            ? wt.unknownUsage
                            : task.billingStatus === "reserved"
                              ? `${t.reserved}: ${task.reservedCredits} Credits`
                              : `${task.chargedCredits} Credits`}
                        </p>
                      </div>
                    </div>
                  </article>
                ))}
                {sending?.sessionId === active && !tasks.some((task) =>
                  task.id === sending.taskId || (!sending.before.has(task.id) && task.message === sending.message)) && (
                  <article className="agent-turn mx-auto text-sm" data-agent-sending>
                    <div className="agent-user-message ml-auto w-fit">
                      <p className="whitespace-pre-wrap break-words">{sending.message}</p>
                      {sending.context && (
                        <p
                          className="agent-message-context"
                          title={sending.context.path}
                          style={{ color: "var(--ink-faint)" }}
                        >
                          {t.taskContext}: {sending.context.title}
                        </p>
                      )}
                    </div>
                    <div className="agent-content-column mt-3">
                      <AgentProgress task={sendingProgress} />
                    </div>
                  </article>
                )}
                {running && (
                  <div className="agent-content-column">
                    <AgentProgress
                      task={progress.data?.task.id === running.id && progress.dataUpdatedAt > conversation.dataUpdatedAt ? progress.data.task : running}
                      events={progress.data?.task.id === running.id ? progress.data.events : undefined}
                      approvalHint={t.waitingApproval}
                    />
                  </div>
                )}
              </div>
              {session && (
                <div className="agent-composer-wrap shrink-0" style={border}>
                  <div className="agent-composer">
                    {selected.size > 0 && (
                      <button
                        type="button"
                        className={`${control} mb-1 border`}
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            const failed: string[] = [];
                            for (const op of operations.filter(
                              (item) =>
                                selected.has(item.id) &&
                                item.status === "pending",
                            )) {
                              try {
                                await actOnAgentOperation(op, "approve");
                                setSelected((old) => {
                                  const next = new Set(old);
                                  next.delete(op.id);
                                  return next;
                                });
                              } catch (e) {
                                failed.push(errorMessage(e));
                              }
                            }
                            await refresh();
                            if (failed.length)
                              throw new Error(
                                `${t.selectedFailure} ${failed.join("; ")}`,
                              );
                          })
                        }
                      >
                        {t.selected} ({selected.size})
                      </button>
                    )}
                    <div
                      className="agent-context flex min-w-0 items-center gap-1"
                      style={{ color: "var(--ink-faint)" }}
                      title={
                        currentFocus
                          ? `${currentFocus.path}\n${t.metadataOnly}`
                          : t.metadataOnly
                      }
                    >
                      {currentFocus ? (
                        <>
                          <FileText size={13} className="shrink-0" />
                          <span className="truncate">
                            {t.context}: {currentFocus.title}
                          </span>
                          <button
                            type="button"
                            aria-label={t.removeContext}
                            className="shrink-0 p-1"
                            onClick={() =>
                              setLayout((s) => ({
                                ...s,
                                ignored: {
                                  ...s.ignored,
                                  [active]: currentFocus.path,
                                },
                              }))
                            }
                          >
                            <X size={12} />
                          </button>
                        </>
                      ) : (
                        <>
                          <span>{t.noContext}</span>
                          {focus && (
                            <button
                              type="button"
                              aria-label={t.attachContext}
                              title={`${focus.title}\n${focus.path}`}
                              className={`${control} ml-1`}
                              onClick={() =>
                                setLayout((s) => {
                                  const next = { ...s.ignored };
                                  delete next[active];
                                  return { ...s, ignored: next };
                                })
                              }
                            >
                              {t.attachContext}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    {adjusting[active] && (
                      <div className="flex items-center gap-2 text-xs">
                        <span>{t.adjusting}</span>
                        <button
                          type="button"
                          className={control}
                          onClick={() =>
                            setLayout((s) => {
                              const next = { ...s.adjusting };
                              delete next[active];
                              return { ...s, adjusting: next };
                            })
                          }
                        >
                          {t.stopAdjust}
                        </button>
                      </div>
                    )}
                    <textarea
                      ref={inputRef}
                      aria-label={t.input}
                      placeholder={running ? t.busy : t.input}
                      rows={2}
                      maxLength={16000}
                      value={draft}
                      onChange={(e) => setDraft(active, e.target.value)}
                      onCompositionStart={() => { composingInput.current = true; }}
                      onCompositionEnd={() => { composingInput.current = false; }}
                      onBlur={() => { composingInput.current = false; }}
                      onKeyDown={(e) => {
                        // WebKit can report isComposing=false on the Enter that
                        // commits an IME candidate, while keyCode is still 229.
                        if (
                          e.key !== "Enter" || composingInput.current ||
                          e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229
                        ) return;
                        if (e.ctrlKey) {
                          e.preventDefault();
                          const input = e.currentTarget;
                          if (input.value.length - (input.selectionEnd - input.selectionStart) < input.maxLength) {
                            input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end");
                            setDraft(active, input.value);
                          }
                        } else if (!e.shiftKey && !e.metaKey && !e.altKey) {
                          e.preventDefault();
                          if (!e.repeat && !busy && !running && draft.trim() && config.data?.enabled)
                            void send();
                        }
                      }}
                      className="agent-input block w-full resize-y bg-transparent text-sm outline-none"
                    />
                    <div className="agent-composer-tools flex flex-wrap items-center justify-between text-xs">
                      <div className="agent-composer-options flex min-w-0 flex-wrap items-center">
                        <label
                          className="agent-permission flex items-center gap-1"
                          title={permissionHelp}
                        >
                          <ShieldCheck size={14} aria-hidden="true" />
                          <span className="sr-only">{t.permission}</span>
                          <select
                            aria-label={t.permission}
                            value={session.permission}
                            disabled={busy}
                            onChange={(e) =>
                              void changePermission(
                                e.target.value as AgentPermission,
                              )
                            }
                            className="agent-select"
                          >
                            {permissions.map((mode) => (
                              <option key={mode} value={mode}>
                                {t[mode]}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      {running ? (
                        <button
                          type="button"
                          className={`${control} flex items-center gap-1 border`}
                          style={border}
                          disabled={busy || running.cancelRequested}
                          onClick={() =>
                            void perform(async () => {
                              await cancelWritingTask(running.id);
                              await refresh();
                            })
                          }
                        >
                          <Square size={12} />
                          {running.cancelRequested ? wt.cancelling : wt.cancel}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="agent-send flex items-center gap-1.5 disabled:opacity-40"
                          title={t.sendShortcut}
                          disabled={
                            busy || !draft.trim() || !config.data?.enabled
                          }
                          onClick={send}
                        >
                          <ArrowUp size={16} />
                          {t.send}
                        </button>
                      )}
                    </div>
                    {!config.data?.enabled && (
                      <p className="mt-1 text-xs" role="status">
                        {config.isError
                          ? errorMessage(config.error)
                          : config.isPending
                            ? wt.loading
                            : wt.unavailable}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <div
        className="agent-statusbar flex shrink-0 items-center justify-between gap-2 text-[11px]"
        style={border}
      >
        <button
          type="button"
          aria-expanded={layout.open}
          className="flex items-center gap-1.5"
          onClick={() => setLayout((s) => ({ ...s, open: !s.open }))}
        >
          {!layout.open && <AgentAvatar className="agent-avatar-status" />}
          {t.assistantName}{" "}
          {liveCounts.running > 0 && (
            <span>
              · {liveCounts.running} {t.running}
            </span>
          )}
          {liveCounts.pending > 0 && (
            <span>
              · {liveCounts.pending} {t.pending}
            </span>
          )}
        </button>
        {session && (
          <span className="truncate" style={{ color: "var(--ink-faint)" }}>
            {t.cloud} · {formatBytes(session.usedBytes, locale)} ·{" "}
            {session.chargedCredits ?? 0} Credits
          </span>
        )}
      </div>
      {(deleting || renaming) && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={deleting ? t.delete : t.rename}
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/20 p-4"
        >
          <div
            className="w-full max-w-md rounded-xl border bg-[var(--ink-paper)] p-4 shadow-xl"
            style={border}
          >
            {error && (
              <p role="alert" className="mb-2 text-xs text-red-700">
                {error}
              </p>
            )}
            <p className="mb-3 text-sm">
              {deleting
                ? `${deleting.title} · ${formatBytes(deleting.usedBytes, locale)}`
                : t.rename}
            </p>
            {deleting ? (
              <p className="text-xs leading-relaxed">{t.confirmDelete}</p>
            ) : (
              <input
                autoFocus
                aria-label={t.rename}
                maxLength={100}
                value={rename}
                onChange={(e) => setRename(e.target.value)}
                className="w-full rounded border bg-transparent p-2 text-sm"
                style={border}
              />
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className={control}
                disabled={busy}
                onClick={() => {
                  setDeleting(null);
                  setRenaming(null);
                }}
              >
                {t.back}
              </button>
              <button
                type="button"
                className={`${control} border`}
                style={border}
                disabled={busy || (!!renaming && !rename.trim())}
                onClick={() =>
                  void perform(async () => {
                    if (deleting) {
                      const id = deleting.id;
                      await deleteAgentSession(id);
                      closeTab(id);
                      qc.removeQueries({
                        queryKey: ["agent-session", accountKey, id],
                      });
                      await requests.clearSession(id);
                      setLayout((s) => {
                        const drafts = { ...s.drafts };
                        const draftIds = { ...s.draftIds };
                        const draftSubmissions = { ...s.draftSubmissions };
                        const skills = { ...s.skills };
                        const scroll = { ...s.scroll };
                        delete drafts[id];
                        delete draftIds[id];
                        delete draftSubmissions[id];
                        delete skills[id];
                        delete scroll[id];
                        return { ...s, drafts, draftIds, draftSubmissions, skills, scroll };
                      });
                      setDeleting(null);
                    } else if (renaming) {
                      await updateAgentSession(renaming.id, {
                        title: rename.trim(),
                        revision: renaming.revision,
                      });
                      setRenaming(null);
                    }
                    await refresh();
                  })
                }
              >
                {deleting ? t.confirm : t.save}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function OperationCard({
  operation: op,
  busy,
  error,
  selected,
  onSelect,
  onAction,
  onAdjust,
  onOpenDocument,
  grouped = false,
}: {
  operation: AgentOperation;
  busy: boolean;
  error: string;
  selected: boolean;
  onSelect: () => void;
  onAction: (action: "approve" | "reject" | "undo") => void;
  onAdjust: () => void;
  onOpenDocument?: (docId: string) => void;
  grouped?: boolean;
}) {
  const { locale } = useI18n();
  const t = agentPanelText[locale];
  const [expanded, setExpanded] = useState(false);
  const hasContent = op.input.kind === "update" || op.input.kind === "create";
  const actions = (
      <div className="agent-proposal-actions flex flex-wrap items-center gap-2">
        {onOpenDocument &&
          (op.result?.docId || op.before?.document.docId) &&
          op.input.kind !== "trash" && op.input.kind !== "delete_folder" &&
          !(op.input.kind === "create" && op.status === "undone") && (
            <button
              type="button"
              className={control}
              onClick={() => {
                setExpanded(false);
                onOpenDocument(op.result?.docId || op.before!.document.docId);
              }}
            >
              {t.openDoc}
            </button>
          )}
        {op.status === "pending" && !grouped && (
          <>
            <button
              type="button"
              className={`${control} agent-primary`}
              style={border}
              disabled={busy}
              onClick={() => onAction("approve")}
            >
              <Check size={13} />
              {t.approve}
            </button>
            <button
              type="button"
              className={control}
              disabled={busy}
              onClick={() => onAction("reject")}
            >
              {t.reject}
            </button>
            <button type="button" className={control} onClick={() => { setExpanded(false); onAdjust(); }}>
              {t.adjust}
            </button>
          </>
        )}
        {op.status === "applied" && (
          <button
            type="button"
            className={control}
            disabled={busy}
            onClick={() => onAction("undo")}
          >
            {t.undo}
          </button>
        )}
      </div>
  );
  return (
    <section
      className="agent-proposal"
      style={border}
      data-operation-id={op.id}
    >
      <div className="agent-proposal-heading flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {op.status === "pending" && !grouped && (
            <input
              type="checkbox"
              aria-label={`${t.selected}: ${op.before?.folder?.name || op.input.title || op.before?.document.title}`}
              checked={selected}
              onChange={onSelect}
              className="agent-proposal-checkbox"
            />
          )}
          <div className="min-w-0">
            <p className="agent-proposal-kind">
              <FileText size={12} />
              {t[op.input.kind]}
            </p>
            <p className="agent-proposal-title" title={op.input.path}>
              {op.before?.folder?.name || op.input.title || op.before?.document.title}
            </p>
            <p className="mt-1 text-xs" style={{ color: "var(--ink-mid)" }}>
              {op.input.explanation}
            </p>
          </div>
        </div>
        <span className={`agent-state agent-state-${op.status}`}>
          <span className="agent-state-dot" />
          {t[op.status]}
        </span>
      </div>
      {(op.input.path || op.input.folderId || op.input.kind === "move") && (
        <details className="agent-target-details">
          <summary>{t.target}</summary>
          <p>
            {op.input.path}
            {op.input.kind === "move"
              ? ` → ${op.input.folderId || t.root}`
              : ""}
          </p>
        </details>
      )}
      {op.approval && op.approval !== "user" && (
        <p className="mt-2 text-xs">
          {t.auto}: {op.reason}
        </p>
      )}
      {hasContent && (
        <button
          type="button"
          className={`${control} agent-diff-toggle`}
          aria-haspopup="dialog"
          onClick={() => setExpanded(true)}
        >
          {t.diff}
          <Maximize2 size={13} />
        </button>
      )}
      {actions}
      {expanded && <AgentDiffDialog
        beforeTitle={op.before?.document.title ?? ""}
        afterTitle={op.input.title ?? op.before?.document.title ?? ""}
        beforeContent={op.before?.document.content ?? ""}
        afterContent={op.input.content ?? ""}
        actions={actions}
        error={error}
        onClose={() => setExpanded(false)}
      />}
    </section>
  );
}

function LegacyProposal({
  task,
  busy,
  error,
  onApply,
}: {
  task: WritingTask;
  busy: boolean;
  error: string;
  onApply: () => void;
}) {
  const { locale } = useI18n();
  const t = writingAgentText[locale];
  const [expanded, setExpanded] = useState(false);
  const actions = task.appliedDocument ? <p>{t.applied}</p> : (
    <button type="button" disabled={busy || task.status !== "completed" || task.cancelRequested}
      className={`${control} border`} style={border} onClick={onApply}>{t.apply}</button>
  );
  return (
    <section className="rounded border p-3 text-xs" style={border}>
      <p className="font-medium">
        {t.proposal} · {task.proposal?.title}
      </p>
      <button type="button" className={`${control} agent-diff-toggle`} aria-haspopup="dialog" onClick={() => setExpanded(true)}>
        {agentPanelText[locale].diff}<Maximize2 size={13} />
      </button>
      <div className="agent-proposal-actions">{actions}</div>
      {expanded && <AgentDiffDialog
        beforeTitle={task.source.title}
        afterTitle={task.proposal?.title ?? ""}
        beforeContent={task.source.content}
        afterContent={task.proposal?.content ?? ""}
        actions={actions}
        error={error}
        onClose={() => setExpanded(false)}
      />}
    </section>
  );
}
