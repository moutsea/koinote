import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentArtifact, AgentOperation } from "../agentSessions";
import { agentTaskReply, agentTaskResult } from "../agentTaskResult";
import { useI18n } from "../i18n";
import { agentPanelText } from "../i18n/agentPanel";
import type { WritingTask } from "../writingAgent";

const plugins = [remarkGfm];
const components: Components = {
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

export function AgentTaskReply({ task, operations, artifacts }: {
  task: WritingTask;
  operations: AgentOperation[];
  artifacts?: AgentArtifact[];
}) {
  const { locale, t } = useI18n();
  const result = agentTaskResult(task, operations, locale, artifacts);
  const reply = agentTaskReply(task);
  if (!result && !reply && !task.loadedSkills?.length) return null;
  return (
    <div className="agent-message-body prose prose-sm min-w-0 max-w-none break-words dark:prose-invert" data-task-result={task.id}>
      {Boolean(task.loadedSkills?.length) && <p className="not-prose mb-2 text-xs" style={{ color: "var(--ink-mid)" }}>{t.koi.loadedSkills} {task.loadedSkills!.map((skill) => skill.name).join(" · ")}</p>}
      {reply && <div data-task-reply={task.id}>
        <Markdown remarkPlugins={plugins} components={components}>{reply}</Markdown>
        <p className="not-prose mb-1 mt-3 text-xs font-medium" style={{ color: "var(--ink-mid)" }}>{agentPanelText[locale].currentResult}</p>
      </div>}
      <Markdown remarkPlugins={plugins} components={components}>{result}</Markdown>
    </div>
  );
}
