import type { WritingTask } from "./writingAgent";
import type { Locale } from "./i18n/types";
import { writingAgentText } from "./i18n/writingAgent";
import { agentPanelText } from "./i18n/agentPanel";

export function agentTaskBilling(
  task: Pick<WritingTask, "coverGeneration" | "chargedCredits" | "reservedCredits" | "billingStatus">,
  locale: Locale,
): string {
  const t = writingAgentText[locale];
  const imageCredits = task.coverGeneration?.chargedCredits ?? 0;
  if (imageCredits > 0) {
    const text = task.billingStatus === "reserved" ? t.textReserved.replace("{credits}", String(task.reservedCredits))
      : task.billingStatus === "needs_review" ? t.unknownUsage
      : t.textCharge.replace("{credits}", String(Math.max(0, task.chargedCredits - imageCredits)));
    return `${t.imageCharge.replace("{credits}", String(imageCredits))} · ${text}`;
  }
  if (task.billingStatus === "needs_review") return `${task.chargedCredits} Credits · ${t.unknownUsage}`;
  if (task.billingStatus === "reserved") return `${agentPanelText[locale].reserved}: ${task.reservedCredits} Credits`;
  return `${task.chargedCredits} Credits`;
}
