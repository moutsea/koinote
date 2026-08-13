import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Gift, Mail } from "lucide-react";
import {
  login,
  register,
  sendVerificationCode,
  verifyEmail,
  ApiError,
} from "../api";
import { useI18n } from "../i18n";
import { GoogleIcon, GitHubIcon } from "../components/BrandIcons";
import { InkClouds, PaperCard } from "../components/Ink";
import { Logo } from "../components/Logo";

type Mode = "login" | "register";

function loginRedirectPath() {
  const candidate = new URLSearchParams(window.location.search).get("redirectTo")?.trim() ?? "";
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) {
    return "/dashboard";
  }
  return candidate;
}

// OAuth 走整页跳转到后端 start 端点，成功后由后端签发会话并跳回 redirectTo。
function startOAuth(provider: "google" | "github", invitationCode: string, redirectTo: string) {
  const search = new URLSearchParams({ redirectTo });
  if (invitationCode.trim()) search.set("invite", invitationCode.trim());
  window.location.assign(`/api/auth/oauth/${provider}/start?${search.toString()}`);
}

export function LoginPage({ initialMode = "login" }: { initialMode?: Mode }) {
  const queryClient = useQueryClient();
  const { locale, t } = useI18n();
  const redirectTo = loginRedirectPath();

  const [mode, setMode] = useState<Mode>(initialMode);
  const [identifier, setIdentifier] = useState(""); // 登录用：用户名或邮箱
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [invitationCode, setInvitationCode] = useState(
    () =>
      new URLSearchParams(window.location.search)
        .get("invite")
        ?.trim()
        .toUpperCase() ?? "",
  );
  const [showInvitationInput, setShowInvitationInput] = useState(
    invitationCode !== "",
  );
  const [showEmailRegistration, setShowEmailRegistration] = useState(
    initialMode === "login",
  );
  const [recoveryEmail, setRecoveryEmail] = useState<string | null>(null);
  const [sendingCode, setSendingCode] = useState(false);
  const [codeCooldown, setCodeCooldown] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isEmailRecovery = mode === "login" && recoveryEmail !== null;

  // 把后端错误码翻译成当前语言；未知码回退到后端英文 message 或通用提示。
  function translateError(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.code && t.errors[err.code]) return t.errors[err.code];
      return err.message || t.auth.requestFailed;
    }
    if (err instanceof Error) return err.message;
    return t.auth.requestFailed;
  }

  // OAuth 回调失败时后端会跳回 /login?error=<code>，这里读出来翻译展示。
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) {
      setError(t.errors[code] ?? t.auth.requestFailed);
      // 清掉 URL 上的 error 参数，避免刷新时反复弹
      const url = new URL(window.location.href);
      url.searchParams.delete("error");
      window.history.replaceState({}, "", url.toString());
    }
    // 仅挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (codeCooldown <= 0) return;
    const timer = window.setTimeout(() => setCodeCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [codeCooldown]);

  async function requestCode() {
    setError(null);
    setNotice(null);
    const targetEmail = recoveryEmail ?? email;
    if (!/^\S+@\S+\.\S+$/.test(targetEmail)) {
      setError(t.errors.invalid_email ?? t.auth.requestFailed);
      return;
    }
    setSendingCode(true);
    try {
      const result = await sendVerificationCode(targetEmail, locale);
      if (result.devCode) setVerificationCode(result.devCode);
      setCodeCooldown(result.retryAfterSeconds || 60);
      setNotice(
        result.devCode ? t.auth.verificationMockFilled : t.auth.verificationSent,
      );
    } catch (err) {
      setError(translateError(err));
    } finally {
      setSendingCode(false);
    }
  }

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "login") {
        if (recoveryEmail) {
          await verifyEmail({ email: recoveryEmail, password, verificationCode });
        } else {
          await login(identifier, password);
        }
      } else {
        if (password !== confirmPassword) {
          setError(t.auth.passwordMismatch);
          setLoading(false);
          return;
        }
        await register({
          username,
          email,
          password,
          verificationCode,
          invitationCode,
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      window.location.assign(redirectTo);
    } catch (err) {
      if (err instanceof ApiError && err.code === "email_not_verified") {
        const accountEmail = err.email ?? (/^\S+@\S+\.\S+$/.test(identifier) ? identifier : "");
        if (accountEmail) {
          setRecoveryEmail(accountEmail);
          setVerificationCode("");
          setNotice(t.auth.emailVerificationRequired);
          setError(null);
        } else {
          setError(translateError(err));
        }
      } else {
        setError(translateError(err));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="relative flex flex-1 items-center justify-center overflow-hidden px-4 py-12 sm:py-16"
      style={{ background: "var(--ink-paper)" }}
    >
      <InkClouds />
      <div className="w-full max-w-md">
        <div className="mb-7 flex flex-col items-center text-center">
          {/* 不再套朱砂色块：logo 自己已经有朱砂，底色会和它打架。
              直接放大摆着，登录页本就该让品牌大方一点 */}
          <Logo className="h-14 w-14" />
          <h1
            className="kn-heading-cn mt-4 text-2xl font-bold tracking-tight"
            style={{ color: "var(--ink-black)" }}
          >
            {mode === "login" ? t.auth.loginTitle : t.auth.registerTitle}
          </h1>
          <p className="mt-1 text-sm" style={{ color: "var(--ink-mid)" }}>
            {mode === "login" ? t.auth.loginSubtitle : t.auth.registerSubtitle}
          </p>
        </div>

        <PaperCard className="p-5 shadow-sm sm:p-6">
          {/* 错误提示放在面板顶部，同时覆盖 OAuth 回调失败与表单提交失败两种来源 */}
          {error && (
            <p
              role="alert"
              className="mb-5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400"
            >
              {error}
            </p>
          )}

          {/* 第三方登录：置顶作为首选入口，一步完成注册与登录 */}
          <div className="space-y-3">
            <OAuthButton
              onClick={() =>
                startOAuth("google", mode === "register" ? invitationCode : "", redirectTo)
              }
            >
              <GoogleIcon className="h-4 w-4" />
              {t.auth.continueWithGoogle}
            </OAuthButton>
            <OAuthButton
              onClick={() =>
                startOAuth("github", mode === "register" ? invitationCode : "", redirectTo)
              }
            >
              <GitHubIcon className="h-4 w-4" />
              {t.auth.continueWithGitHub}
            </OAuthButton>
          </div>

          {/* 分隔线 */}
          <div
            className="my-6 flex items-center gap-3 text-xs"
            style={{ color: "var(--ink-faint)" }}
          >
            <span
              className="h-px flex-1"
              style={{ background: "var(--ink-line)" }}
            />
            <span className="uppercase tracking-wide">{t.auth.orDivider}</span>
            <span
              className="h-px flex-1"
              style={{ background: "var(--ink-line)" }}
            />
          </div>

          {mode === "register" && (
            <button
              type="button"
              aria-expanded={showEmailRegistration}
              aria-controls="email-registration-form"
              onClick={() => setShowEmailRegistration((visible) => !visible)}
              className="flex w-full items-center justify-center gap-2 rounded-full border px-5 py-2.5 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)]"
              style={{
                borderColor: "var(--ink-line)",
                background: "var(--ink-paper-soft)",
                color: "var(--ink-strong)",
              }}
            >
              <Mail className="h-4 w-4" />
              {showEmailRegistration
                ? t.auth.collapseEmailRegistration
                : t.auth.emailRegistration}
              <ChevronDown
                className={`h-4 w-4 transition-transform ${showEmailRegistration ? "rotate-180" : ""}`}
              />
            </button>
          )}

          {(mode === "login" || showEmailRegistration) && (
          <form
            id={mode === "register" ? "email-registration-form" : undefined}
            onSubmit={submit}
            className={mode === "register" ? "mt-5 space-y-4" : "space-y-4"}
          >
          {isEmailRecovery && (
            <div
              role="status"
              className="rounded-lg border px-3 py-3 text-sm"
              style={{
                borderColor: "var(--ink-line)",
                background: "var(--ink-wash)",
                color: "var(--ink-mid)",
              }}
            >
              <p className="font-semibold" style={{ color: "var(--ink-strong)" }}>
                {t.auth.verifyEmailTitle}
              </p>
              <p className="mt-1 text-xs">{t.auth.verifyEmailDescription}</p>
            </div>
          )}

          {mode === "register" && (
            <Field
              label={t.auth.username}
              value={username}
              onChange={setUsername}
              autoComplete="username"
              placeholder={t.auth.usernamePlaceholder}
            />
          )}

          {mode === "register" ? (
            <Field
              label={t.auth.email}
              type="email"
              value={email}
              onChange={(value) => {
                setEmail(value);
                setVerificationCode("");
                setCodeCooldown(0);
                setNotice(null);
              }}
              autoComplete="email"
              placeholder={t.auth.emailPlaceholder}
            />
          ) : isEmailRecovery ? (
            <Field
              label={t.auth.email}
              type="email"
              value={recoveryEmail}
              onChange={() => {}}
              autoComplete="email"
              readOnly
            />
          ) : (
            <Field
              label={t.auth.identifier}
              value={identifier}
              onChange={setIdentifier}
              autoComplete="username"
              placeholder={t.auth.identifierPlaceholder}
            />
          )}

          <Field
            label={t.auth.password}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            placeholder={
              mode === "register"
                ? t.auth.passwordPlaceholderRegister
                : t.auth.passwordPlaceholderLogin
            }
          />

          {mode === "register" && (
            <Field
              label={t.auth.confirmPassword}
              type="password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
              placeholder={t.auth.confirmPasswordPlaceholder}
            />
          )}

          {(mode === "register" || isEmailRecovery) && (
            <label className="block">
              <span
                className="mb-1.5 block text-sm font-medium"
                style={{ color: "var(--ink-strong)" }}
              >
                {t.auth.verificationCode}
              </span>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={verificationCode}
                  onChange={(event) =>
                    setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  placeholder={t.auth.verificationCodePlaceholder}
                  required
                  className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm outline-none transition focus:border-[var(--cinnabar)] focus:ring-2 focus:ring-[var(--cinnabar-soft)]"
                  style={{
                    borderColor: "var(--ink-line)",
                    background: "var(--ink-paper)",
                    color: "var(--ink-black)",
                  }}
                />
                <button
                  type="button"
                  onClick={requestCode}
                  disabled={sendingCode || codeCooldown > 0}
                  className="shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold transition hover:bg-[var(--ink-wash-strong)] disabled:cursor-not-allowed disabled:opacity-60"
                  style={{ borderColor: "var(--ink-line)", color: "var(--cinnabar)" }}
                >
                  {sendingCode
                    ? t.auth.sendingVerificationCode
                    : codeCooldown > 0
                      ? `${t.auth.resendVerificationCode} ${codeCooldown}s`
                      : t.auth.sendVerificationCode}
                </button>
              </div>
            </label>
          )}

          {notice && (
            <p
              role="status"
              className="rounded-lg px-3 py-2 text-xs"
              style={{ background: "var(--ink-wash)", color: "var(--ink-mid)" }}
            >
              {notice}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-full px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
            style={{ background: "var(--cinnabar)" }}
          >
            {loading
              ? t.auth.processing
              : isEmailRecovery
                ? t.auth.verifyAndLogin
                : mode === "login"
                ? t.auth.submitLogin
                : t.auth.submitRegister}
          </button>
          </form>
          )}

          {/* 邀请码对三种注册方式都有效，因此固定放在面板最底部。 */}
          {mode === "register" && (
            <div
              className="mt-5 border-t pt-5"
              style={{ borderColor: "var(--ink-line)" }}
            >
              {showInvitationInput ? (
                <div
                  className="rounded-xl border px-4 py-3.5"
                  style={{
                    borderColor: "var(--cinnabar-soft)",
                    background: "var(--cinnabar-soft)",
                  }}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                      style={{
                        background: "var(--ink-paper-soft)",
                        color: "var(--cinnabar)",
                      }}
                    >
                      <Gift className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        className="text-sm font-semibold"
                        style={{ color: "var(--ink-black)" }}
                      >
                        {t.auth.invitationRewardTitle}
                      </p>
                      <p
                        className="mt-0.5 text-xs leading-relaxed"
                        style={{ color: "var(--ink-mid)" }}
                      >
                        {t.auth.invitationBonusHint}
                      </p>
                    </div>
                  </div>
                  <label className="mt-3 block">
                    <span className="sr-only">{t.auth.invitationCode}</span>
                    <input
                      type="text"
                      value={invitationCode}
                      onChange={(event) =>
                        setInvitationCode(
                          event.target.value.toUpperCase().slice(0, 16),
                        )
                      }
                      autoComplete="off"
                      maxLength={16}
                      placeholder={t.auth.invitationCodePlaceholder}
                      className="w-full rounded-lg border px-3 py-2 font-mono text-sm tracking-wider outline-none transition focus:border-[var(--cinnabar)] focus:ring-2 focus:ring-[var(--cinnabar-soft)]"
                      style={{
                        borderColor: "var(--ink-line)",
                        background: "var(--ink-paper-soft)",
                        color: "var(--ink-black)",
                      }}
                    />
                  </label>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowInvitationInput(true)}
                  className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition hover:bg-[var(--ink-wash)]"
                  style={{ color: "var(--ink-mid)" }}
                >
                  <Gift className="h-3.5 w-3.5" />
                  {t.auth.haveInvitationCode}
                </button>
              )}
            </div>
          )}
        </PaperCard>

        <p className="mt-6 text-center text-sm" style={{ color: "var(--ink-mid)" }}>
          {isEmailRecovery
            ? ""
            : mode === "login"
              ? t.auth.noAccount
              : t.auth.hasAccount}
          <button
            type="button"
            onClick={() => {
              if (isEmailRecovery) {
                setRecoveryEmail(null);
                setVerificationCode("");
                setCodeCooldown(0);
                setNotice(null);
              } else {
                const nextMode = mode === "login" ? "register" : "login";
                setMode(nextMode);
                setShowEmailRegistration(nextMode === "login");
              }
              setError(null);
            }}
            className={isEmailRecovery ? "font-medium hover:underline" : "ml-1 font-medium hover:underline"}
            style={{ color: "var(--cinnabar)" }}
          >
            {isEmailRecovery
              ? t.auth.backToLogin
              : mode === "login"
                ? t.auth.toRegister
                : t.auth.toLogin}
          </button>
        </p>
      </div>
    </div>
  );
}

function OAuthButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-center gap-2.5 rounded-full border px-5 py-2.5 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)]"
      style={{
        borderColor: "var(--ink-line)",
        background: "var(--ink-paper-soft)",
        color: "var(--ink-strong)",
      }}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  placeholder,
  hint,
  readOnly = false,
  required = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  hint?: string;
  readOnly?: boolean;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span
        className="mb-1.5 block text-sm font-medium"
        style={{ color: "var(--ink-strong)" }}
      >
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        readOnly={readOnly}
        required={required}
        // 焦点环用朱砂：全站的强调色只有这一个
        className="w-full rounded-lg border px-3 py-2 text-sm outline-none transition focus:border-[var(--cinnabar)] focus:ring-2 focus:ring-[var(--cinnabar-soft)]"
        style={{
          borderColor: "var(--ink-line)",
          background: "var(--ink-paper)",
          color: "var(--ink-black)",
        }}
      />
      {hint && (
        <span className="mt-1.5 block text-xs leading-relaxed" style={{ color: "var(--ink-faint)" }}>
          {hint}
        </span>
      )}
    </label>
  );
}

// 供路由懒加载引用的包装导出，预设好 initialMode
export function LoginRoute() {
  return <LoginPage initialMode="login" />;
}

export function RegisterRoute() {
  return <LoginPage initialMode="register" />;
}
