import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../spa/src/i18n";
import { WritingAgentPanel } from "../../spa/src/components/editor/WritingAgentPanel";

const docId = "00000000-0000-4000-8000-000000000001";
const document = {
  docId,
  title: "原始标题",
  content: "原来的第一段。\n\n保留这一段。",
  revision: 4,
  theme: "",
  share: null,
};
const task = {
  id: "00000000-0000-4000-8000-000000000002",
  source: document,
  message: "改进文章",
  status: "completed",
  result: "已读取文章并生成提案，等待你的确认。",
  error: "",
  proposal: {
    title: "清晰的标题",
    content: "修改后的第一段。\n\n保留这一段。",
    explanation: "改进开头，保留原意。",
    hash: "proposal-hash",
  },
  appliedDocument: null,
  reservedCredits: 100,
  chargedCredits: 2,
  billingStatus: "settled",
  usage: { totalTokens: 3000 },
  createdAt: new Date().toISOString(),
  cancelRequested: false,
};
const state = {
  submissions: [] as unknown[],
  applied: [] as unknown[],
  accepted: false,
  created: false,
  prepared: 0,
};
Object.assign(window, { writingUITest: state });
window.fetch = async (request, init) => {
  const path =
    typeof request === "string"
      ? request
      : request instanceof URL
        ? request.href
        : request.url;
  const respond = (value: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  if (path.endsWith("/config"))
    return respond({
      enabled: true,
      reservedCredits: 100,
      skills: [
        { repositoryId: 7, name: "我的写作 Skill", path: "writing/SKILL.md" },
      ],
    });
  if (path.includes("/tasks?"))
    return respond({ tasks: state.created ? [task] : [] });
  if (path.endsWith("/tasks") && init?.method === "POST") {
    state.submissions.push(JSON.parse(String(init.body)));
    if (state.submissions.length === 1)
      return respond({ error: "Temporary connection failure" }, 503);
    state.created = true;
    return respond({ task }, 202);
  }
  if (path.endsWith("/apply")) {
    state.applied.push(JSON.parse(String(init?.body)));
    if (location.search.includes("conflict"))
      return respond(
        { error: "The document changed", code: "revision_conflict" },
        409,
      );
    return respond({
      document: { ...document, ...task.proposal, revision: 5 },
    });
  }
  if (path.includes("/tasks/"))
    return respond({
      task: {
        ...task,
        appliedDocument: state.accepted ? { ...document, revision: 5 } : null,
      },
      events: [
        {
          seq: 1,
          event: {
            type: "tool.completed",
            toolCall: { name: "koinote.get_document" },
          },
        },
      ],
    });
  if (path.includes("/documents/")) return respond({ document });
  return respond({});
};
const qc = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
createRoot(window.document.getElementById("root")!).render(
  <QueryClientProvider client={qc}>
    <I18nProvider>
      <WritingAgentPanel
        docId={docId}
        member
        localMode={false}
        onPrepare={async () => {
          state.prepared++;
          return true;
        }}
        onAccept={async () => {
          state.accepted = true;
          return true;
        }}
        onClose={() => {}}
      />
    </I18nProvider>
  </QueryClientProvider>,
);
