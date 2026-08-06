import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { login, register, ApiError } from "../api";
import { useI18n } from "../i18n";
import { GoogleIcon, GitHubIcon } from "../components/BrandIcons";
import { InkClouds } from "../components/Ink";

type Mode = "login" | "register";

// OAuth 走整页跳转到后端 start 端点，成功后由后端签发会话并跳回 redirectTo。
function startOAuth(provider: "google" | "github") {
  const search = new URLSearchParams({ redirectTo: "/dashboard" });
  window.location.assign(`/api/auth/oauth/${provider}/start?${search.toString()}`);
}

export function LoginPage({ initialMode = "login" }: { initialMode?: Mode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useI18n();

  const [mode, setMode] = useState<Mode>(initialMode);
  const [identifier, setIdentifier] = useState(""); // 登录用：用户名或邮箱
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "login") {
        await login(identifier, password);
      } else {
        if (password !== confirmPassword) {
          setError(t.auth.passwordMismatch);
          setLoading(false);
          return;
        }
        await register({ username, email, password });
      }
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      void navigate({ to: "/dashboard" });
    } catch (err) {
      setError(translateError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="relative flex flex-1 items-center justify-center overflow-hidden px-4 py-16"
      style={{ background: "var(--ink-paper)" }}
    >
      <InkClouds />
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-xl"
            style={{
              background: "var(--cinnabar-soft)",
              color: "var(--cinnabar)",
            }}
          >
            <FileText className="h-6 w-6" />
          </div>
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

        {/* 错误提示放在最上方，同时覆盖 OAuth 回调失败与表单提交失败两种来源 */}
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
          <OAuthButton onClick={() => startOAuth("google")}>
            <GoogleIcon className="h-4 w-4" />
            {t.auth.continueWithGoogle}
          </OAuthButton>
          <OAuthButton onClick={() => startOAuth("github")}>
            <GitHubIcon className="h-4 w-4" />
            {t.auth.continueWithGitHub}
          </OAuthButton>
        </div>

        {/* 分隔线 */}
        <div
          className="my-6 flex items-center gap-3 text-xs"
          style={{ color: "var(--ink-faint)" }}
        >
          <span className="h-px flex-1" style={{ background: "var(--ink-line)" }} />
          <span className="uppercase tracking-wide">{t.auth.orDivider}</span>
          <span className="h-px flex-1" style={{ background: "var(--ink-line)" }} />
        </div>

        <form
          onSubmit={submit}
          className="space-y-4 rounded-xl border p-6"
          style={{
            borderColor: "var(--ink-line)",
            background: "var(--ink-paper-soft)",
          }}
        >
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
              onChange={setEmail}
              autoComplete="email"
              placeholder={t.auth.emailPlaceholder}
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

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-full px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
            style={{ background: "var(--cinnabar)" }}
          >
            {loading
              ? t.auth.processing
              : mode === "login"
                ? t.auth.submitLogin
                : t.auth.submitRegister}
          </button>
        </form>

        <p className="mt-6 text-center text-sm" style={{ color: "var(--ink-mid)" }}>
          {mode === "login" ? t.auth.noAccount : t.auth.hasAccount}
          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
            className="ml-1 font-medium hover:underline"
            style={{ color: "var(--cinnabar)" }}
          >
            {mode === "login" ? t.auth.toRegister : t.auth.toLogin}
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
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
        required
        // 焦点环用朱砂：全站的强调色只有这一个
        className="w-full rounded-lg border px-3 py-2 text-sm outline-none transition focus:border-[var(--cinnabar)] focus:ring-2 focus:ring-[var(--cinnabar-soft)]"
        style={{
          borderColor: "var(--ink-line)",
          background: "var(--ink-paper)",
          color: "var(--ink-black)",
        }}
      />
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
