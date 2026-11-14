import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Check, ChevronRight, CircleAlert, LoaderCircle, Sparkles } from "lucide-react";
import { agentActivitySteps, agentProgress } from "../agentProgress";
import { useI18n } from "../i18n";
import { agentProgressText } from "../i18n/agentProgress";
import { getWritingTask, writingFinished, type WritingTask } from "../writingAgent";
import "./AgentTaskActivity.css";

export function AgentTaskActivity({ task }: { task: WritingTask }) {
  const { locale } = useI18n();
  const t = agentProgressText[locale];
  const [open, setOpen] = useState(false);
  const finished = writingFinished(task);
  const activity = useInfiniteQuery({
    // Refetch the final snapshot even if the live record was already open.
    queryKey: ["agent-task-activity", task.id, finished],
    queryFn: ({ pageParam }) => getWritingTask(task.id, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: page => page.nextBefore || undefined,
    enabled: open,
    refetchInterval: finished ? false : 2_500,
  });
  const snapshot = activity.data?.pages[0]?.task;
  const skills = [...new Map([...(snapshot?.loadedSkills ?? []), ...(task.loadedSkills ?? [])]
    .map(skill => [skill.id, skill])).values()];
  const steps = agentActivitySteps(activity.data?.pages.flatMap(page => page.events) ?? []);
  // The conversation owns task status; an older detail request must not move it
  // back from completed/approval to running.
  const { phase } = agentProgress(task);
  return (
    <details className="agent-task-activity" data-task-activity={task.id} open={open}
      onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <ChevronRight size={14} className="agent-task-activity-chevron" aria-hidden="true" />
        <span className="agent-task-activity-title">{t.history}</span>
        <span className="agent-task-activity-phase">{t.phases[phase]}</span>
        {skills.length > 0 && <span className="agent-task-activity-skill-summary">
          <Sparkles size={12} aria-hidden="true" />
          {t.loadedSkills} · {skills.map(skill => skill.name).join(" · ")}
        </span>}
      </summary>
      {open && <div className="agent-task-activity-body">
        <div className="agent-task-activity-skills">
          <p className="agent-task-activity-label">{t.skills}</p>
          {skills.length > 0 ? <>
            <ul>{skills.map(skill => <li key={skill.id}><Sparkles size={12} aria-hidden="true" />{skill.name}</li>)}</ul>
            <p className="agent-task-activity-note">{t.skillNote}</p>
          </> : activity.isSuccess ? <p className="agent-task-activity-note">{t.noSkills}</p> : null}
        </div>
        {activity.isPending && <p role="status" className="agent-task-activity-note">{t.loading}</p>}
        {activity.isError && <p role="alert" className="agent-task-activity-error">
          {t.loadError} <button type="button" disabled={activity.isFetching} onClick={() => {
            if (activity.isFetchNextPageError) void activity.fetchNextPage();
            else void activity.refetch();
          }}>{t.retry}</button>
        </p>}
        {activity.data && <>
          <p className="agent-task-activity-label">{t.steps}</p>
          {activity.hasNextPage && <button className="agent-task-activity-older" type="button"
            disabled={activity.isFetching} onClick={() => void activity.fetchNextPage()}>
            {activity.isFetchingNextPage ? t.loading : t.older}
          </button>}
          {steps.length ? <ol className="agent-task-activity-steps" aria-label={t.steps}>
            {steps.map(step => {
              const pending = step.status === "started" && !finished;
              const Icon = step.status === "completed" ? Check : step.status === "failed" ? CircleAlert
                : pending ? LoaderCircle : CircleAlert;
              return <li key={step.seq} data-step-status={step.status}>
                <Icon size={13} aria-hidden="true" className={pending ? "agent-progress-spinner" : undefined} />
                <span>{t.actions[step.action]}</span>
                <span className="agent-task-activity-step-status">{step.status === "completed" ? t.stepDone
                  : step.status === "failed" ? t.stepFailed : pending ? t.phases.running : t.stepUnconfirmed}</span>
              </li>;
            })}
          </ol> : <p className="agent-task-activity-note">{t.empty}</p>}
        </>}
      </div>}
    </details>
  );
}
