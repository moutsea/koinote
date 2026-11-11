import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentOperation } from "../agentSessions";
import { agentTaskResult } from "../agentTaskResult";
import { useI18n } from "../i18n";
import type { WritingTask } from "../writingAgent";

const plugins = [remarkGfm];
const components: Components = {
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

export function AgentTaskReply({ task, operations }: {
  task: WritingTask;
  operations: AgentOperation[];
}) {
  const { locale, t } = useI18n();
  const result = agentTaskResult(task, operations, locale);
  if (!result && !task.loadedSkills?.length) return null;
  return (
    <div className="agent-message-body prose prose-sm min-w-0 max-w-none break-words dark:prose-invert" data-task-result={task.id}>
      {Boolean(task.loadedSkills?.length) && <p className="not-prose mb-2 text-xs" style={{ color: "var(--ink-mid)" }}>{t.koi.loadedSkills} {task.loadedSkills!.map((skill) => skill.name).join(" · ")}</p>}
      <Markdown remarkPlugins={plugins} components={components}>{result}</Markdown>
    </div>
  );
}
