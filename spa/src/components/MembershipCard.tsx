import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Crown,
  HardDrive,
  Sparkles,
  UserRound,
} from "lucide-react";
import {
  ApiError,
  confirmMembershipCheckout,
  getMembershipStatus,
  type User,
} from "../api";
import { interpolate, useI18n } from "../i18n";
import { formatBytes } from "../storage";
import { PaperCard } from "./Ink";
import { STORAGE_USAGE_KEY } from "./StorageCard";
import { isTerminalBillingHTTPStatus } from "../billingCore";

export const MEMBERSHIP_STATUS_KEY = ["membership-status"] as const;

type CheckoutNotice =
  | "none"
  | "success"
  | "pending"
  | "delayed"
  | "cancelled"
  | "failed";

function clearCheckoutQuery() {
  const url = new URL(window.location.href);
  url.searchParams.delete("checkout");
  url.searchParams.delete("session_id");
  window.history.replaceState(null, "", url);
}

export function MembershipCard({ user }: { user: User }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const handledReturn = useRef(false);
  const [notice, setNotice] = useState<CheckoutNotice>("none");

  const status = useQuery({
    queryKey: MEMBERSHIP_STATUS_KEY,
    queryFn: getMembershipStatus,
    retry: false,
  });

  useEffect(() => {
    if (handledReturn.current) return;
    handledReturn.current = true;

    const url = new URL(window.location.href);
    const checkoutResult = url.searchParams.get("checkout");
    const sessionId = url.searchParams.get("session_id");
    if (checkoutResult === "cancelled") {
      setNotice("cancelled");
      clearCheckoutQuery();
      return;
    }
    if (checkoutResult !== "success" || !sessionId) return;

    setNotice("pending");
    void confirmMembershipCheckout(sessionId)
      .then(async (result) => {
        if (result.status === "pending") {
          setNotice("pending");
          return;
        }
        if (result.user) {
          queryClient.setQueryData(["session"], { user: result.user });
        }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["session"] }),
          queryClient.invalidateQueries({ queryKey: MEMBERSHIP_STATUS_KEY }),
          queryClient.invalidateQueries({ queryKey: STORAGE_USAGE_KEY }),
        ]);
        setNotice("success");
        clearCheckoutQuery();
      })
      .catch((error) => {
        if (
          error instanceof ApiError &&
          isTerminalBillingHTTPStatus(error.status)
        ) {
          setNotice("failed");
          return;
        }
        setNotice("pending");
      });
  }, [queryClient]);

  useEffect(() => {
    if (notice !== "pending") return;
    let attempts = 0;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const result = await queryClient.fetchQuery({
          queryKey: MEMBERSHIP_STATUS_KEY,
          queryFn: getMembershipStatus,
        });
        if (result.membership.active) {
          setNotice("success");
          clearCheckoutQuery();
          void queryClient.invalidateQueries({ queryKey: ["session"] });
          void queryClient.invalidateQueries({ queryKey: STORAGE_USAGE_KEY });
          return;
        }
      } catch (error) {
        if (
          error instanceof ApiError &&
          isTerminalBillingHTTPStatus(error.status)
        ) {
          setNotice("failed");
          return;
        }
      }
      if (cancelled) return;
      if (attempts >= 30) {
        setNotice("delayed");
        return;
      }
      timer = window.setTimeout(poll, 2_000);
    };
    timer = window.setTimeout(poll, 2_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [notice, queryClient]);

  const membership = status.data?.membership;
  const active = membership?.active ?? user.membershipTier === "lifetime";
  const currentStorage = membership
    ? formatBytes(membership.storageQuotaBytes, locale)
    : "—";

  const noticeText =
    notice === "success"
      ? t.membership.checkoutSuccess
      : notice === "pending"
        ? t.membership.checkoutPending
        : notice === "delayed"
          ? t.membership.checkoutDelayed
          : notice === "cancelled"
            ? t.membership.checkoutCancelled
            : notice === "failed"
              ? t.membership.checkoutFailed
              : "";

  return (
    <PaperCard>
      <div className="p-6 sm:p-7">
        {noticeText && (
          <div
            className="mb-5 rounded-lg border px-4 py-3 text-sm"
            style={{
              borderColor: "var(--ink-line)",
              background: "var(--ink-wash)",
              color: "var(--ink-strong)",
            }}
            role="status"
          >
            {noticeText}
          </div>
        )}

        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-2xl flex-1">
            <p
              className="text-xs font-semibold uppercase tracking-[0.16em]"
              style={{ color: "var(--ink-faint)" }}
            >
              {t.membership.currentPlan}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="rounded-lg p-2"
                style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}
              >
                {active ? <Crown className="h-5 w-5" /> : <UserRound className="h-5 w-5" />}
              </span>
              <h2
                className="kn-heading-cn text-lg font-bold"
                style={{ color: "var(--ink-black)" }}
              >
                {active ? t.membership.title : t.membership.freePlan}
              </h2>
              {active && (
                <span
                  className="rounded-full border px-2.5 py-1 text-xs font-medium"
                  style={{
                    borderColor: "var(--ink-line)",
                    background: "var(--ink-wash)",
                    color: "var(--ink-mid)",
                  }}
                >
                  {t.membership.activeBadge}
                </span>
              )}
            </div>

            <p className="mt-3 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
              {active ? t.membership.activeDescription : t.membership.freeDescription}
            </p>
          </div>

          {active && (
            <div className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>
              <Check className="h-5 w-5" />
              {t.membership.activeTitle}
            </div>
          )}
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Benefit
            icon={<HardDrive className="h-4 w-4" />}
            title={interpolate(t.membership.currentStorageBenefit, {
              quota: currentStorage,
            })}
          />
          {active ? (
            <Benefit
              icon={<Sparkles className="h-4 w-4" />}
              title={t.membership.aiBenefit}
              detail={t.membership.aiComingSoon}
            />
          ) : (
            <Benefit
              icon={<Check className="h-4 w-4" />}
              title={t.membership.freeCoreBenefit}
            />
          )}
        </div>

        {!active && (
          <div
            className="mt-6 flex justify-end border-t pt-5"
            style={{ borderColor: "var(--ink-line)" }}
          >
            <Link
              to="/pricing"
              className="inline-flex items-center justify-center rounded-full border px-4 py-2 text-sm font-medium transition hover:bg-[var(--ink-wash)]"
              style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
            >
              {t.settingsPage.upgrade}
            </Link>
          </div>
        )}
      </div>
    </PaperCard>
  );
}

function Benefit({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
}) {
  return (
    <div className="flex items-start gap-2.5 text-sm" style={{ color: "var(--ink-strong)" }}>
      <span className="mt-0.5" style={{ color: "var(--ink-mid)" }}>
        {icon}
      </span>
      <span>
        <span className="font-medium">{title}</span>
        {detail && (
          <span className="mt-0.5 block text-xs" style={{ color: "var(--ink-faint)" }}>
            {detail}
          </span>
        )}
      </span>
    </div>
  );
}
