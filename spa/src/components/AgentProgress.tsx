import { CircleCheck, CirclePause, CircleAlert, LoaderCircle, Square } from "lucide-react";
import { agentProgress } from "../agentProgress";
import { useI18n } from "../i18n";
import { agentProgressText } from "../i18n/agentProgress";
import type { WritingEvent, WritingTask } from "../writingAgent";
import "./AgentProgress.css";

export function AgentProgress({ task, events, approvalHint }: {
  task: WritingTask;
  events?: readonly WritingEvent[];
  approvalHint?: string;
}) {
  const { locale } = useI18n();
  const t = agentProgressText[locale];
  const { phase, steps } = agentProgress(task, events);
  const paused = phase === "awaiting_approval" || phase === "clarification";
  const ended = ["completed", "failed", "cancelled", "partial"].includes(phase);
  const Icon = paused ? CirclePause : phase === "completed" ? CircleCheck
    : phase === "failed" || phase === "partial" ? CircleAlert
    : phase === "cancelled" ? Square : LoaderCircle;
  return (
    <section className="agent-progress" data-agent-progress={task.id} aria-label={t.title}>
      <p className="agent-progress-eyebrow">{t.title}</p>
      <div className="agent-progress-current" role="status" aria-atomic="true">
        <Icon size={16} aria-hidden="true" className={!paused && !ended ? "agent-progress-spinner" : undefined} />
        <span>{t.phases[phase]}</span>
      </div>
      {phase === "awaiting_approval" && approvalHint && <p className="agent-progress-hint">{approvalHint}</p>}
      {steps.length > 0 && (
        <ol className="agent-progress-steps" aria-label={t.recent}>
          {steps.map(step => (
            <li key={step.seq}>
              <span className="agent-progress-dot" aria-hidden="true" />
              <span>{t.actions[step.action]}{step.failed && ` · ${t.stepFailed}`}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
