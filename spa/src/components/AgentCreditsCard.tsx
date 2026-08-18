import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, LoaderCircle } from "lucide-react";
import type { User } from "../api";
import {
  AGENT_CREDITS_QUERY_KEY,
  ApiError,
  confirmAgentCreditsCheckout,
  createAgentCreditsCheckout,
  getAgentCredits,
  type AgentCreditPack,
} from "../api";
import { isTerminalBillingHTTPStatus } from "../billingCore";
import { openMembershipCheckout } from "../externalNavigation";
import { interpolate, useI18n } from "../i18n";
import { PaperCard } from "./Ink";

type CreditCheckoutNotice =
  | "none"
  | "success"
  | "pending"
  | "delayed"
  | "cancelled"
  | "failed";

function clearCreditCheckoutQuery() {
  const url = new URL(window.location.href);
  url.searchParams.delete("credit_checkout");
  url.searchParams.delete("session_id");
  window.history.replaceState(null, "", url);
}

export function formatCreditPackPrice(pack: AgentCreditPack, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: pack.currency.toUpperCase(),
    }).format(pack.amount / 100);
  } catch {
    return `${pack.currency.toUpperCase()} ${(pack.amount / 100).toFixed(2)}`;
  }
}

export function AgentCreditsCard({ user }: { user: User }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const handledReturn = useRef(false);
  const [notice, setNotice] = useState<CreditCheckoutNotice>("none");
  const member = user.membershipTier === "lifetime";
  const credits = useQuery({
    queryKey: AGENT_CREDITS_QUERY_KEY,
    queryFn: getAgentCredits,
    enabled: member && !user.isLocalMode,
    retry: false,
  });
  const checkout = useMutation({
    mutationFn: async (pack: AgentCreditPack) => {
      const result = await createAgentCreditsCheckout(pack.code);
      await openMembershipCheckout(result.url);
      return result;
    },
    onError(error) {
      if (error instanceof ApiError && error.code === "checkout_in_progress") {
        setNotice("pending");
        return;
      }
      setNotice("failed");
    },
  });

  useEffect(() => {
    if (!member || handledReturn.current) return;
    handledReturn.current = true;
    const url = new URL(window.location.href);
    const result = url.searchParams.get("credit_checkout");
    const sessionId = url.searchParams.get("session_id");
    if (result === "cancelled") {
      setNotice("cancelled");
      clearCreditCheckoutQuery();
      return;
    }
    if (result !== "success" || !sessionId) return;

    setNotice("pending");
    void confirmAgentCreditsCheckout(sessionId)
      .then(async (confirmation) => {
        if (confirmation.status !== "active") return;
        await queryClient.invalidateQueries({ queryKey: AGENT_CREDITS_QUERY_KEY });
        setNotice("success");
        clearCreditCheckoutQuery();
      })
      .catch((error) => {
        if (error instanceof ApiError && isTerminalBillingHTTPStatus(error.status)) {
          setNotice("failed");
        }
      });
  }, [member, queryClient]);

  useEffect(() => {
    if (notice !== "pending") return;
    const url = new URL(window.location.href);
    const sessionId = url.searchParams.get("session_id");
    if (!sessionId) return;

    let attempts = 0;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const result = await confirmAgentCreditsCheckout(sessionId);
        if (result.status === "active") {
          await queryClient.invalidateQueries({ queryKey: AGENT_CREDITS_QUERY_KEY });
          if (!cancelled) {
            setNotice("success");
            clearCreditCheckoutQuery();
          }
          return;
        }
      } catch (error) {
        if (error instanceof ApiError && isTerminalBillingHTTPStatus(error.status)) {
          if (!cancelled) setNotice("failed");
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

  const data = credits.data?.credits;
  // A 409 checkout_in_progress response has no session_id in the URL and is
  // recoverable by opening the existing checkout again. Only lock the packs
  // while we are polling a concrete return-session, otherwise a transient
  // response would leave this card permanently disabled until a page reload.
  const returnSessionId = typeof window === "undefined"
    ? ""
    : new URL(window.location.href).searchParams.get("session_id") ?? "";
  const pollingCheckout = notice === "pending" && returnSessionId !== "";
  const noticeText =
    notice === "success"
      ? t.agentCredits.checkoutSuccess
      : notice === "pending"
        ? t.agentCredits.checkoutPending
        : notice === "delayed"
          ? t.agentCredits.checkoutDelayed
          : notice === "cancelled"
            ? t.agentCredits.checkoutCancelled
            : notice === "failed"
              ? t.agentCredits.checkoutFailed
              : "";

  return (
    <PaperCard className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <Coins className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--ink-faint)" }} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold" style={{ color: "var(--ink-black)" }}>
              {t.agentCredits.title}
            </h2>
            {data && (
              <span
                className="rounded-full border px-2.5 py-1 text-xs font-medium"
                style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
              >
                {interpolate(t.agentCredits.available, { count: data.available })}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
            {member ? t.agentCredits.description : t.agentCredits.membersOnly}
          </p>
        </div>
      </div>

      {noticeText && (
        <p
          className="mt-4 rounded-md border px-3 py-2 text-sm"
          role="status"
          style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)", color: "var(--ink-strong)" }}
        >
          {noticeText}
        </p>
      )}

      {member && credits.isLoading && (
        <p className="mt-4 text-sm" style={{ color: "var(--ink-faint)" }}>
          {t.agentCredits.loading}
        </p>
      )}
      {member && credits.isError && (
        <p className="mt-4 text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>
          {t.agentCredits.loadFailed}
        </p>
      )}
      {data && (
        <>
          <div className="mt-5 grid grid-cols-3 gap-3 border-y py-4" style={{ borderColor: "var(--ink-line)" }}>
            <CreditMetric label={t.agentCredits.balance} value={data.balance} />
            <CreditMetric label={t.agentCredits.reserved} value={data.reserved} />
            <CreditMetric label={t.agentCredits.availableLabel} value={data.available} />
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {data.packs.map((pack) => (
              <button
                key={pack.code}
                type="button"
                onClick={() => checkout.mutate(pack)}
                disabled={!data.purchaseEnabled || checkout.isPending || pollingCheckout || notice === "delayed"}
                className="flex min-h-20 flex-col items-start justify-center rounded-md border px-4 py-3 text-left transition hover:bg-[var(--ink-wash)] disabled:cursor-not-allowed disabled:opacity-50"
                style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
              >
                <span className="font-semibold">{pack.credits.toLocaleString(locale)} credits</span>
                <span className="mt-1 text-sm" style={{ color: "var(--ink-mid)" }}>
                  {formatCreditPackPrice(pack, locale)}
                </span>
              </button>
            ))}
          </div>
          {!data.purchaseEnabled && (
            <p className="mt-3 text-xs" style={{ color: "var(--ink-faint)" }}>
              {t.agentCredits.purchaseUnavailable}
            </p>
          )}
          {checkout.isPending && (
            <p className="mt-3 flex items-center gap-2 text-sm" style={{ color: "var(--ink-mid)" }}>
              <LoaderCircle className="h-4 w-4 animate-spin" />
              {t.agentCredits.redirecting}
            </p>
          )}

          {data.transactions.length > 0 && (
            <div className="mt-5">
              <h3 className="text-sm font-medium" style={{ color: "var(--ink-strong)" }}>
                {t.agentCredits.history}
              </h3>
              <div className="mt-2 divide-y" style={{ borderColor: "var(--ink-line)" }}>
                {data.transactions.slice(0, 5).map((transaction) => (
                  <div key={transaction.entryId} className="flex items-center justify-between gap-4 py-2.5 text-sm">
                    <span style={{ color: "var(--ink-mid)" }}>
                      {t.agentCredits.transactionKinds[transaction.kind] ?? transaction.kind}
                    </span>
                    <span className="font-medium tabular-nums" style={{ color: "var(--ink-strong)" }}>
                      {transaction.amount > 0 ? "+" : ""}{transaction.amount.toLocaleString(locale)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </PaperCard>
  );
}

function CreditMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs" style={{ color: "var(--ink-faint)" }}>{label}</p>
      <p className="mt-1 font-semibold tabular-nums" style={{ color: "var(--ink-black)" }}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}
