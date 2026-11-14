import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../spa/src/i18n";
import { ArticleAgentPanel } from "../../spa/src/components/editor/ArticleAgentPanel";
import { AgentBottomPanel } from "../../spa/src/components/AgentBottomPanel";
import { AgentRequestCache, readPendingAgentRequests } from "../../spa/src/agentRequestCache";
import { readArchivedAgentRequests } from "../../spa/src/agentRequestArchive";
import {
  setAgentFocus,
  readAgentPanelLayout,
  readAgentPanelLayoutSnapshot,
  saveAgentPanelLayout,
  type AgentSession,
  type AgentOperation,
  type AgentArtifact,
} from "../../spa/src/agentSessions";
import type { WritingEvent, WritingTask } from "../../spa/src/writingAgent";
import type { Folder } from "../../spa/src/api";
import { useFolderList } from "../../spa/src/documents";
import { isModalOpen } from "../../spa/src/modalStack";
import { openAgentOrganizer } from "../../spa/src/agentContext";

function FolderTreeProbe() {
  const folders = useFolderList(true);
  return (
    <output data-folder-tree data-loading={folders.isFetching}>
      {folders.data?.map((folder) => folder.name).join(", ")}
    </output>
  );
}

const firstDoc = "00000000-0000-4000-8000-000000000001";
const secondDoc = "00000000-0000-4000-8000-000000000002";
type ServerState = {
  artifacts?: AgentArtifact[];
  events?: Record<string, WritingEvent[]>;
  approvalRequests?: Array<{ taskId: string; count: number; action: string }>;
  approvalResumes?: number;
  sessions: AgentSession[];
  tasks: Record<string, WritingTask[]>;
  operations: AgentOperation[];
  permission: string;
  folders: Folder[];
  documentTitles: Record<string, string>;
  requests: Record<
    string,
    { sessionId: string; input: string; task: WritingTask }
  >;
};
const articleFixture = new URLSearchParams(location.search).has("article");
const serverKey = articleFixture ? "article-panel-fixture-server" : "agent-panel-fixture-server";
const saved = localStorage.getItem(serverKey);
const server: ServerState = saved
  ? JSON.parse(saved)
  : {
      sessions: [],
      tasks: {},
      operations: [],
      permission: "review",
      folders: [],
      documentTitles: {},
      requests: {},
    };
const state = {
  coverPreviewFail: new URLSearchParams(location.search).has("cover-preview-fail"),
  coverDownloadFail: false,
  coverDownloads: 0,
  coverErrorCode: "",
  coverUsageIncomplete: false,
  coverCapability: "",
  openOrganizer: openAgentOrganizer,
  libraryConflicts: [] as string[],
  libraryPreparations: 0,
  requestCache: () => new AgentRequestCache("agent-ui-test"),
  archivedRequests: (sessionId: string, draftId?: string) => readArchivedAgentRequests("agent-ui-test", sessionId, draftId),
  layoutStorage: {
    read: readAgentPanelLayout,
    snapshot: readAgentPanelLayoutSnapshot,
    save: saveAgentPanelLayout,
  },
  pendingRequests: () => readPendingAgentRequests("agent-ui-test"),
  submissions: [] as Record<string, unknown>[],
  applied: [] as string[],
  prepared: 0,
  manageSkillsOpened: 0,
  openedDocuments: [] as string[],
  isModalOpen,
  folderFetches: 0,
  localFolders: [] as Folder[],
  pullTree(options: { force?: boolean; pullOnly?: boolean; strictPull?: boolean }) {
    if (!options.force || !options.pullOnly || !options.strictPull) throw new Error("expected a forced read-only tree pull");
    const shared = localStorage.getItem(serverKey);
    this.localFolders = structuredClone(shared ? JSON.parse(shared).folders : server.folders);
    return Promise.resolve({ state: "idle" });
  },
  failFirst: true,
  failNextOperation: false,
  failTaskDetails: false,
  taskDetailRequests: 0,
  loseNextResponse: false,
  holdNextResponse: false,
  // Blocks session page reads, so tests can see what renders before refresh().
  holdPages: false,
  heldPages: [] as (() => void)[],
  releasePages() {
    this.holdPages = false;
    for (const release of this.heldPages.splice(0)) release();
  },
  loseHeldResponse: false,
  responseHeld: false,
  releaseResponse: async () => {},
  server,
  startBackgroundTask(sessionID: string) {
    const session = server.sessions.find((item) => item.id === sessionID)!;
    const task = {
      ...server.tasks[sessionID][0],
      id: crypto.randomUUID(),
      message: "创建文件夹",
      result: "",
      status: "running" as const,
      createdAt: new Date().toISOString(),
    };
    server.tasks[sessionID].unshift(task);
    session.activeTasks++;
    session.updatedAt = new Date().toISOString();
    persist();
  },
  applyBackgroundFolder(sessionID: string) {
    const session = server.sessions.find((item) => item.id === sessionID)!;
    const task = server.tasks[sessionID][0];
    const folderId = crypto.randomUUID();
    server.folders.push({
      folderId,
      name: "后台生成文件夹",
      parentFolderId: null,
      organizerKind: null,
    });
    server.operations.push({
      id: crypto.randomUUID(),
      taskId: task.id,
      hash: "background-folder",
      input: {
        key: "folder",
        kind: "folder",
        title: "后台生成文件夹",
        explanation: "按用户要求创建",
      },
      before: null,
      status: "applied",
      approval: "full",
      reason: "用户已完全授权",
      result: { folderId },
      createdAt: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();
    persist();
  },
  completeBackgroundTask(sessionID: string) {
    const session = server.sessions.find((item) => item.id === sessionID)!;
    server.tasks[sessionID][0].status = "completed";
    server.tasks[sessionID][0].result = "后台创建完成";
    session.activeTasks--;
    session.updatedAt = new Date().toISOString();
    persist();
  },
  switchDoc(id = secondDoc) {
    return setAgentFocus({
      docId: id,
      title:
        server.documentTitles[id] ??
        (id === firstDoc ? "云南旅行记录" : "产品介绍"),
      path: `/documents/${id}`,
      prepare: async () => {
        state.prepared++;
        return true;
      },
    });
  },
};
state.switchDoc(firstDoc);
Object.assign(window, { agentUITest: state });
const persist = () =>
  localStorage.setItem(serverKey, JSON.stringify(server));
const respond = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
window.fetch = async (request, init) => {
  // Separate browser tabs share this fake API, just as they share the backend.
  // Refresh before each request instead of overwriting another tab's state.
  const saved = localStorage.getItem(serverKey);
  if (saved) Object.assign(server, JSON.parse(saved));
  const url = new URL(
    typeof request === "string"
      ? request
      : request instanceof URL
        ? request.href
        : request.url,
    location.origin,
  );
  const path = url.pathname;
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (path.startsWith("/api/agent/artifacts/")) {
    const preview = url.searchParams.has("preview");
    if (!preview) state.coverDownloads++;
    if (preview ? state.coverPreviewFail : state.coverDownloadFail) return new Response(null, { status: 503 });
    const canvas = document.createElement("canvas");
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#e6eee5"; ctx.fillRect(0, 0, 640, 360);
    return new Response(await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/jpeg")), { headers: { "Content-Type": preview ? "image/jpeg" : "application/octet-stream" } });
  }
  const article = path.match(/^\/api\/documents\/([^/]+)\/koi-session$/);
  if (article && method==="POST") {
    const id = "article-"+article[1];
    if(!server.sessions.some(s=>s.id===id))server.sessions.push({id,title:"当前文章",writeDocumentId:article[1],permission:"review",revision:1,updatedAt:new Date().toISOString(),usedBytes:0,chargedCredits:0,activeTasks:0,pendingOperations:0});
    persist();return page(id);
  }
  if (path === "/api/folders") {
    state.folderFetches++;
    return respond({ folders: state.localFolders });
  }
  if (path === "/api/writing-agent/config")
    return respond({
      enabled: true,
      reservedCredits: 100,
      skills: [
        { repositoryId: 7, name: "我的写作 Skill", path: "writing/SKILL.md" },
      ],
    });
  if (path === "/api/agent/session-settings") {
    if (method === "PUT") {
      server.permission = body.permission;
      persist();
    }
    return respond({ permission: server.permission });
  }
  if (path === "/api/agent/sessions") {
    if (method === "POST") {
      if (!server.sessions.some((s) => s.id === body.id))
        server.sessions.unshift({
          id: body.id,
          title: "新会话",
          permission: server.permission as AgentSession["permission"],
          revision: 1,
          updatedAt: new Date().toISOString(),
          usedBytes: 1200,
          chargedCredits: 0,
          activeTasks: 0,
          pendingOperations: 0,
        });
      persist();
      return page(body.id);
    }
    return respond({
      sessions: server.sessions.filter((s) =>
        s.title.includes(url.searchParams.get("q") ?? ""),
      ),
      nextCursor: "",
    });
  }
  const sessionMatch = path.match(
    /^\/api\/agent\/sessions\/([^/]+)(\/tasks)?$/,
  );
  if (sessionMatch) {
    const id = sessionMatch[1];
    const session = server.sessions.find((s) => s.id === id);
    if (!session) return respond({ error: "not found" }, 404);
    if (sessionMatch[2]) {
      state.submissions.push(body);
      const existing = server.requests[body.requestId];
      if (existing) {
        if (existing.sessionId !== id || existing.input !== JSON.stringify(body))
          return respond({ error: "idempotency conflict" }, 409);
        return respond({ task: existing.task });
      }
      if (state.failFirst) {
        state.failFirst = false;
        throw new Error("Temporary connection failure");
      }
      const taskId = crypto.randomUUID();
      session.title = body.message.slice(0, 40);
      session.updatedAt = new Date().toISOString();
      session.chargedCredits += 2;
      const source = {
        docId: session.writeDocumentId ?? body.context?.path.split("/").pop() ?? firstDoc,
        title: body.context?.title ?? "新文章",
        path: body.context?.path,
        content: "",
        revision: 0,
      };
      const task: WritingTask = {
        id: taskId,
        message: body.message,
        source,
        status: "completed",
        result: articleFixture
          ? ["## 修改建议", "", "- **保留数字**，精简开头。", "", "```text", "# 原文示例", "```", "",
              "| 原文 | 修改 |", "| --- | --- |", "| 第一段 | 精简 |", "", "<iframe src='about:blank'></iframe>"].join("\n")
          : "已读取原文，并准备了一份开头修改。",
        error: "",
        proposal: null,
        appliedDocument: null,
        reservedCredits: 100,
        chargedCredits: 2,
        billingStatus: "settled",
        usage: { totalTokens: 3100 },
        cancelRequested: false,
        createdAt: new Date().toISOString(),
      };
      server.tasks[id] = [task, ...(server.tasks[id] ?? [])];
      const auto = session.permission === "full";
      const cover = body.message.includes("生成封面");
      if (cover) {
        state.coverCapability = new Headers(init?.headers).get("X-Koinote-Agent-Covers") ?? "";
        task.result = "封面已生成，可在下方预览和下载。";
        task.taskIntent = {outcome: "operations_reported", inputVersion: 1, ...(body.message.includes("标题") ? {reply: "三个标题建议：\n1. 山间来信\n2. 云南慢行\n3. 把日子写成诗"} : {})};
        task.chargedCredits = 22;
        if (state.coverErrorCode) {
          task.result = "koinote.generate_cover: 宿主未提供可识别的执行状态";
          task.taskIntent.outcome = "partial";
          task.coverGeneration = {status:"failed",errorCode:state.coverErrorCode,chargedCredits:0};
          task.chargedCredits = 2;
        } else {
          task.coverGeneration = {status:"completed",chargedCredits:20};
          if (state.coverUsageIncomplete) { task.billingStatus = "needs_review"; task.chargedCredits = 20; task.usage = null; }
          (server.artifacts ??= []).push({id: crypto.randomUUID(), taskId, name: "koi-cover-fixture.jpg", mimeType: "image/jpeg", bytes: 1024});
        }
      }
      if (!cover || body.message.includes("润色")) {
      server.operations.push({
        id: crypto.randomUUID(),
        taskId,
        hash: "immutable-proposal",
        input: {
          key: "edit",
          kind: "update",
          title: source.title,
          path: source.path,
          content:
            "抵达云南的第一天，我们从古城开始这段旅程。\n\n保留原来的第二段。",
          explanation: "交代地点与行程，保留原有叙述。",
        },
        before: {
          document: {
            docId: source.docId,
            title: source.title,
            content: "原来的第一段。\n\n保留原来的第二段。",
            revision: 4,
          } as never,
          folderId: "",
          path: source.path ?? "",
        },
        status: auto ? "applied" : "pending",
        approval: auto ? "full" : "",
        reason: auto ? "用户已完全授权" : "等待审批",
        result: auto ? { docId: source.docId, revision: 5 } : null,
        createdAt: new Date().toISOString(),
      });
      session.pendingOperations = auto ? 0 : 1;
      }
      server.requests[body.requestId] = {
        sessionId: id,
        input: JSON.stringify(body),
        task,
      };
      if (state.loseNextResponse) {
        state.loseNextResponse = false;
        server.documentTitles[source.docId] = "Agent renamed article";
        state.switchDoc(source.docId);
        persist();
        throw new Error("Accepted response was lost");
      }
      persist();
      if (state.holdNextResponse) {
        state.holdNextResponse = false;
        state.responseHeld = true;
        await new Promise<void>((resolve) => {
          state.releaseResponse = async () => {
            resolve();
            // Let the response and its async caller finish before assertions.
            await new Promise((done) => setTimeout(done, 0));
          };
        });
        if (state.loseHeldResponse) {
          state.loseHeldResponse = false;
          throw new Error("Accepted held response was lost");
        }
      }
      return respond({ task }, 202);
    }
    if (method === "DELETE") {
      server.sessions = server.sessions.filter((s) => s.id !== id);
      delete server.tasks[id];
      persist();
      return respond({ deleted: true });
    }
    if (method === "PUT") {
      if (body.revision !== session.revision)
        return respond({ error: "state changed" }, 409);
      if (body.title) session.title = body.title;
      if (body.permission) session.permission = body.permission;
      session.revision++;
      persist();
    }
    if (method === "GET" && state.holdPages)
      await new Promise<void>((resolve) => state.heldPages.push(resolve));
    return page(id);
  }
  const taskMatch = path.match(/^\/api\/writing-agent\/tasks\/([^/]+)$/);
  if (taskMatch) {
    state.taskDetailRequests++;
    if (state.failTaskDetails) return respond({ error: "Task details temporarily unavailable" }, 503);
    const task = Object.values(server.tasks).flat().find(t => t.id === taskMatch[1]);
    const before = Number(url.searchParams.get("before"));
    const events = (server.events?.[taskMatch[1]] ?? []).filter(e => !before || e.seq < before).sort((a, b) => b.seq - a.seq);
    return task ? respond({ task, events: events.slice(0, 100), nextBefore: events.length > 100 ? events[99].seq : 0 }) : respond({ error: "not found" }, 404);
  }
  const batchMatch = path.match(/^\/api\/agent\/tasks\/([^/]+)\/operations\/(approve|reject|undo)$/);
  if (batchMatch) {
    if (state.failNextOperation) { state.failNextOperation = false; return respond({ error: "Approval temporarily unavailable" }, 503); }
    const batch = body.operations.map((item: { id: string; hash: string }) => server.operations.find(op => op.id === item.id && op.hash === item.hash && op.taskId === batchMatch[1]));
    if (batch.some((op: AgentOperation | undefined) => !op)) return respond({ error: "stale batch" }, 409);
    (server.approvalRequests ??= []).push({ taskId: batchMatch[1], count: batch.length, action: batchMatch[2] });
    const wasPending = batch.some((op: AgentOperation) => op.status === "pending");
    for (const op of batch) {
      op.status = batchMatch[2] === "approve" ? "applied" : batchMatch[2] === "undo" ? "undone" : "rejected";
      op.approval = "user";
      const folderId = op.before?.folder?.folderId ?? op.input.targetId;
      if ((op.input.kind === "folder" && op.status === "applied") || (op.input.kind === "delete_folder" && op.status === "undone")) {
        server.folders.push({ folderId, name: op.before?.folder?.name ?? op.input.title, parentFolderId: null, organizerKind: null });
      } else if (op.input.kind === "delete_folder" && op.status === "applied") {
        server.folders = server.folders.filter(f => f.folderId !== folderId);
      }
      if (op.status === "applied") op.result = { folderId: op.input.targetId };
    }
    for (const session of server.sessions) {
      const task = server.tasks[session.id]?.find(t => t.id === batchMatch[1]);
      if (task && wasPending) {
        task.status = "running";
        task.result = "已收到审批结果，继续执行后续步骤。";
        session.pendingOperations = 0;
        session.updatedAt = new Date().toISOString();
        server.approvalResumes = (server.approvalResumes ?? 0) + 1;
      }
    }
    persist(); return respond({ operations: batch });
  }
  const operationMatch = path.match(
    /^\/api\/agent\/operations\/([^/]+)\/(approve|reject|undo)$/,
  );
  if (operationMatch) {
    if (state.failNextOperation) {
      state.failNextOperation = false;
      return respond({ error: "Approval temporarily unavailable" }, 503);
    }
    const operation = server.operations.find(
      (op) => op.id === operationMatch[1],
    )!;
    if (body.hash !== operation.hash)
      return respond({ error: "hash mismatch" }, 409);
    state.applied.push(operation.id);
    operation.status =
      operationMatch[2] === "approve"
        ? "applied"
        : operationMatch[2] === "reject"
          ? "rejected"
          : "undone";
    operation.approval = "user";
    operation.result = { docId: operation.before!.document.docId, revision: 5 };
    for (const s of server.sessions)
      s.pendingOperations = server.operations.filter(
        (op) =>
          op.status === "pending" &&
          server.tasks[s.id]?.some((task) => task.id === op.taskId),
      ).length;
    persist();
    return respond({ operation });
  }
  return respond({});
};
function page(id: string) {
  const tasks = server.tasks[id] ?? [];
  return respond({
    session: server.sessions.find((s) => s.id === id),
    tasks,
    operations: server.operations.filter((op) =>
      tasks.some((task) => task.id === op.taskId),
    ),
    artifacts: (server.artifacts ?? []).filter((file) => tasks.some((task) => task.id === file.taskId)),
    nextCursor: "",
  });
}
const qc = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
function ArticleFixture() {
  const [current,setCurrent]=React.useState(firstDoc);
  const [opened,setOpened]=React.useState(true);
  return <><button onClick={()=>setCurrent(current===firstDoc?secondDoc:firstDoc)}>切换文章</button>
    <button onClick={()=>setOpened(true)}>Koi AI</button>
    {opened && <ArticleAgentPanel key={current} docId={current} title={current===firstDoc?"甲文":"乙文"} member localMode={false}
        onPrepareReview={async()=>{state.prepared++;return true;}} onClose={()=>setOpened(false)} />}</>;
}
let root = createRoot(document.getElementById("root")!);
const render = () => root.render(
  <QueryClientProvider client={qc}>
    <I18nProvider>
      {articleFixture ? <ArticleFixture/> : <div
        style={{
          height: "100dvh",
          display: "flex",
          flexDirection: "column",
          background: "var(--ink-paper)",
          color: "var(--ink-strong)",
        }}
      >
        <header
          style={{ padding: 18, borderBottom: "1px solid var(--ink-line)" }}
        >
          Koinote{" "}
          <span style={{ marginLeft: 24, fontSize: 12 }}>写作 / 云端文档</span>
        </header>
        <main
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            padding: "35px 9%",
          }}
        >
          <h1 style={{ fontSize: 26 }}>云南旅行记录</h1>
          <FolderTreeProbe />
          <p style={{ marginTop: 20 }}>
            抵达云南的第一天，我们从古城开始这段旅程。
          </p>
          <p style={{ marginTop: 16 }}>
            在底部与 Agent 对话，继续在这里编辑你的文章。
          </p>
        </main>
        <AgentBottomPanel
          accountKey="agent-ui-test"
          onOpenDocument={(id) => { state.openedDocuments.push(id); state.switchDoc(id); }}
        />
      </div>}
    </I18nProvider>
  </QueryClientProvider>,
);
render();
Object.assign(state, {
  async seedProgress(sessionId: string, events: WritingEvent[], status: WritingTask["status"] = "running") {
    const taskId = crypto.randomUUID();
    server.tasks[sessionId] = [{ id: taskId, message: "请帮我整理文档", source: { docId: firstDoc, title: "文档", content: "", revision: 0 }, status, result: "", error: "", proposal: null, appliedDocument: null, reservedCredits: 100, chargedCredits: 0, billingStatus: "reserved", usage: null, cancelRequested: false, createdAt: new Date().toISOString() }];
    (server.events ??= {})[taskId] = events;
    server.sessions.find(s => s.id === sessionId)!.activeTasks = 1;
    persist();
    await qc.invalidateQueries({ queryKey: ["agent-session"] });
    await qc.invalidateQueries({ queryKey: ["agent-sessions"] });
    return taskId;
  },
  async updateProgress(taskId: string, events: WritingEvent[], status: WritingTask["status"], loadedSkills?: WritingTask["loadedSkills"]) {
    const task = Object.values(server.tasks).flat().find(t => t.id === taskId)!;
    task.status = status;
    if (loadedSkills) task.loadedSkills = loadedSkills;
    (server.events ??= {})[taskId] = events;
    persist();
    await qc.invalidateQueries({ queryKey: ["agent-progress"] });
    await qc.invalidateQueries({ queryKey: ["agent-session"] });
  },
  async seedApprovalBatch(sessionId: string, deleting = false) {
    const session = server.sessions.find(s => s.id === sessionId)!;
    const taskId = crypto.randomUUID();
    const task: WritingTask = { id: taskId, message: "整理文档，建立四个主题目录", source: { docId: firstDoc, title: "文档", content: "", revision: 0 }, status: "awaiting_approval", result: "", error: "", proposal: null, appliedDocument: null, reservedCredits: 100, chargedCredits: 0, billingStatus: "reserved", usage: null, cancelRequested: false, createdAt: new Date().toISOString() };
    server.tasks[sessionId] = [task];
    for (let i = 1; i <= (deleting ? 2 : 4); i++) server.operations.push({ id: crypto.randomUUID(), taskId, hash: `folder-hash-${i}`, input: { key: `folder-${i}`, kind: deleting ? "delete_folder" : "folder", ...(deleting ? { path: `/folders/empty-${i}` } : { title: `主题目录 ${i}` }), explanation: "按内容主题归类", targetId: crypto.randomUUID() }, before: deleting ? { folder: { folderId: `empty-${i}`, name: i === 1 ? "202608" : "最近 7 天", parentFolderId: "", organizerKind: "" }, document: { docId: "", title: "", content: "" } as Document, folderId: "", path: `/folders/empty-${i}` } : null, status: "pending", approval: "", reason: "等待审批", result: null, createdAt: new Date().toISOString() });
    if (deleting) {
      for (const op of server.operations.filter(o => o.taskId === taskId)) {
        server.folders.push({ folderId: op.before!.folder!.folderId, name: op.before!.folder!.name, parentFolderId: null, organizerKind: null });
      }
    }
    session.activeTasks = 1; session.pendingOperations = deleting ? 2 : 4; session.updatedAt = new Date().toISOString();
    persist();
    await qc.invalidateQueries({ queryKey: ["agent-session"] });
    await qc.invalidateQueries({ queryKey: ["agent-sessions"] });
    return taskId;
  },
  async finishNativeOperationTask(taskId: string) {
    const task = Object.values(server.tasks).flat().find(t => t.id === taskId)!;
    task.status = "completed";
    task.taskIntent = { outcome: "operations_reported", inputVersion: 1 };
    task.result = server.operations.filter(op => op.taskId === taskId).map(op => `koinote.propose_operations: 宿主确认已应用 (${op.input.path}: delete)`).join("\n");
    const session = server.sessions.find(s => server.tasks[s.id]?.some(t => t.id === taskId))!;
    session.activeTasks = 0;
    persist();
    await qc.invalidateQueries({ queryKey: ["agent-session"] });
    await qc.invalidateQueries({ queryKey: ["agent-sessions"] });
  },
  async showLegacyProposal(show: boolean) {
    server.tasks[server.sessions[0].id][0].proposal = show ? {
      title: "旧版修改提案", content: "旧版提案正文", explanation: "润色", hash: "legacy-proposal",
    } : null;
    persist();
    await qc.invalidateQueries({ queryKey: ["agent-session"] });
  },
  async replaceDiffContent(before: string, after: string, titles?: [string, string]) {
    if (titles) {
      server.operations[0].before!.document.title = titles[0];
      server.operations[0].input.title = titles[1];
    }
    server.operations[0].before!.document.content = before;
    server.operations[0].input.content = after;
    persist();
    await qc.invalidateQueries({ queryKey: ["agent-session"] });
  },
  unmount() {
    root.unmount();
    qc.clear();
  },
  remount() {
    root = createRoot(document.getElementById("root")!);
    render();
  },
});
