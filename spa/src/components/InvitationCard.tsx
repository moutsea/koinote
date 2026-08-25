import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Gift, HardDrive, Users } from "lucide-react";
import { getInvitationOverview } from "../api";
import { koinoteWebURL } from "../externalNavigation";
import { useI18n, interpolate } from "../i18n";
import { formatBytes } from "../storage";
import { PaperCard } from "./Ink";

export const INVITATION_OVERVIEW_KEY = ["invitation-overview"] as const;

export function InvitationCard() {
  const { t, locale } = useI18n();
  const [copied, setCopied] = useState(false);
  const overview = useQuery({
    queryKey: INVITATION_OVERVIEW_KEY,
    queryFn: getInvitationOverview,
    staleTime: 30_000,
  });

  async function copyInviteLink() {
    if (!overview.data) return;
    const url = koinoteWebURL(
      `/register?invite=${encodeURIComponent(overview.data.invitationCode)}`,
    );
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  if (overview.isLoading) {
    return (
      <PaperCard className="p-5">
        <CardHeader title={t.invitations.title} />
        <p className="mt-3 text-sm" style={{ color: "var(--ink-faint)" }}>
          {t.invitations.loading}
        </p>
      </PaperCard>
    );
  }

  if (overview.isError || !overview.data) {
    return (
      <PaperCard className="p-5">
        <CardHeader title={t.invitations.title} />
        <p className="mt-3 text-sm" style={{ color: "var(--ink-faint)" }}>
          {t.invitations.loadFailed}
        </p>
      </PaperCard>
    );
  }

  const data = overview.data;
  const invitedUsers = data.invitedUsers ?? [];
  const reward = formatBytes(data.rewardPerInviteBytes, locale);
  const maxBonus = formatBytes(data.maxBonusStorageBytes, locale);

  return (
    <PaperCard className="overflow-hidden">
      <div
        className="h-1"
        style={{ background: "linear-gradient(90deg, var(--cinnabar), #d6a84b)" }}
      />
      <div className="p-5 sm:p-6">
        <CardHeader title={t.invitations.title} />
        <h2
          className="kn-heading-cn mt-3 text-lg font-bold"
          style={{ color: "var(--ink-black)" }}
        >
          {interpolate(t.invitations.headline, { reward })}
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--ink-mid)" }}>
          {interpolate(t.invitations.description, { reward })}
        </p>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <div
            className="flex min-w-0 flex-1 items-center rounded-lg border px-4 py-2.5 font-mono text-sm tracking-wider"
            style={{
              borderColor: "var(--ink-line)",
              background: "var(--ink-wash)",
              color: "var(--ink-strong)",
            }}
          >
            <span className="truncate">{data.invitationCode}</span>
          </div>
          <button
            type="button"
            onClick={copyInviteLink}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
            style={{ background: "var(--cinnabar)" }}
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? t.invitations.copied : t.invitations.copyLink}
          </button>
        </div>

        <dl className="mt-5 grid gap-3 sm:grid-cols-3">
          <Metric
            icon={<Users className="h-3.5 w-3.5" />}
            label={t.invitations.successful}
            value={String(data.successfulInvites)}
          />
          <Metric
            icon={<Gift className="h-3.5 w-3.5" />}
            label={t.invitations.earned}
            value={formatBytes(data.earnedStorageBytes, locale)}
          />
          <Metric
            icon={<HardDrive className="h-3.5 w-3.5" />}
            label={t.invitations.totalBonus}
            value={formatBytes(data.bonusStorageBytes, locale)}
          />
        </dl>
        <p className="mt-4 text-xs leading-relaxed" style={{ color: "var(--ink-faint)" }}>
          {interpolate(t.invitations.note, { limit: maxBonus })}
        </p>

        <div className="mt-6 border-t pt-5" style={{ borderColor: "var(--ink-line)" }}>
          <h3 className="text-sm font-semibold" style={{ color: "var(--ink-black)" }}>
            {t.settingsPage.invitedUsers}
          </h3>
          {invitedUsers.length === 0 ? (
            <p className="mt-3 text-sm" style={{ color: "var(--ink-faint)" }}>
              {t.settingsPage.invitedUsersEmpty}
            </p>
          ) : (
            <ul className="mt-3 divide-y" style={{ borderColor: "var(--ink-line)" }}>
              {invitedUsers.map((user, index) => (
                <li
                  key={`${user.invitedAt}-${index}`}
                  className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium" style={{ color: "var(--ink-strong)" }}>
                      {user.name}
                    </p>
                    {user.email !== user.name && (
                      <p className="mt-0.5 truncate text-xs" style={{ color: "var(--ink-faint)" }}>
                        {user.email}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-xs sm:text-right" style={{ color: "var(--ink-faint)" }}>
                    <p>
                      {interpolate(t.settingsPage.invitedAt, {
                        date: new Date(user.invitedAt).toLocaleDateString(locale),
                      })}
                    </p>
                    <p className="mt-0.5">
                      {interpolate(t.settingsPage.invitationReward, {
                        reward: formatBytes(user.rewardBytes, locale),
                      })}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </PaperCard>
  );
}

function CardHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2" style={{ color: "var(--cinnabar)" }}>
      <Gift className="h-5 w-5" />
      <span className="text-xs font-medium uppercase tracking-wide">{title}</span>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div
      className="rounded-lg border px-4 py-3"
      style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)" }}
    >
      <dt className="flex items-center gap-1.5 text-xs" style={{ color: "var(--ink-faint)" }}>
        {icon}
        {label}
      </dt>
      <dd className="mt-1 text-base font-semibold" style={{ color: "var(--ink-black)" }}>
        {value}
      </dd>
    </div>
  );
}
