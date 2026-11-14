import Markdown, { type Components } from "react-markdown";
import { Link } from "@tanstack/react-router";
import remarkGfm from "remark-gfm";
import type { AgentArtifact, AgentOperation } from "../agentSessions";
import { agentTaskReply, agentTaskResult } from "../agentTaskResult";
import { useI18n } from "../i18n";
import { agentPanelText } from "../i18n/agentPanel";
import type { WritingTask } from "../writingAgent";

const plugins = [remarkGfm];
const components: Components = {
  a: ({ href, title, children }) => {
    // Product and catalog links stay inside the app, including in desktop.
    if (href === "/repositories" || href === "/repositories?koiInstallable=true") {
      return <Link to="/repositories" search={href.includes("?") ? { koiInstallable: true } : {}} title={title}>{children}</Link>;
    }
    const skills = href?.match(/^\/space\?tab=koi&section=(skills|settings)$/);
    if (skills) {
      return <Link to="/space" search={{ tab: "koi", section: skills[1] as "skills" | "settings" }} title={title}>{children}</Link>;
    }
    const repository = href?.match(/^\/repositories\/([1-9]\d*)(\?installKoi=true)?$/);
    return repository
      ? <Link to="/repositories/$repositoryId" params={{ repositoryId: repository[1] }} search={repository[2] ? { installKoi: true } : {}} title={title}>{children}</Link>
      : <a href={href} title={title}>{children}</a>;
  },
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
  const { locale } = useI18n();
  const result = agentTaskResult(task, operations, locale, artifacts);
  const reply = agentTaskReply(task);
  if (!result && !reply) return null;
  return (
    <div className="agent-message-body prose prose-sm min-w-0 max-w-none break-words dark:prose-invert" data-task-result={task.id}>
      {reply && <div data-task-reply={task.id}>
        <Markdown remarkPlugins={plugins} components={components}>{reply}</Markdown>
        <p className="not-prose mb-1 mt-3 text-xs font-medium" style={{ color: "var(--ink-mid)" }}>{agentPanelText[locale].currentResult}</p>
      </div>}
      <Markdown remarkPlugins={plugins} components={components}>{result}</Markdown>
    </div>
  );
}
