export type EmailEnv = {
  EMAIL: SendEmail;
  EMAIL_FROM_ADDRESS?: string;
  EMAIL_FROM_NAME?: string;
  BACKEND_INTERNAL_TOKEN?: string;
};

type Locale = "en" | "zh" | "fr" | "ja";

const copy: Record<
  Locale,
  { subject: string; heading: string; body: string; expires: string; ignore: string }
> = {
  en: {
    subject: "Your Koinote verification code",
    heading: "Verify your email",
    body: "Use the code below to finish creating your Koinote account.",
    expires: "This code expires in 10 minutes.",
    ignore: "If you did not request this, you can ignore this email.",
  },
  zh: {
    subject: "Koinote 注册验证码",
    heading: "验证你的邮箱",
    body: "请使用以下验证码完成 Koinote 账号注册。",
    expires: "验证码将在 10 分钟后失效。",
    ignore: "如果不是你本人操作，请忽略此邮件。",
  },
  fr: {
    subject: "Votre code de vérification Koinote",
    heading: "Vérifiez votre adresse e-mail",
    body: "Utilisez le code ci-dessous pour terminer la création de votre compte Koinote.",
    expires: "Ce code expire dans 10 minutes.",
    ignore: "Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail.",
  },
  ja: {
    subject: "Koinote メール確認コード",
    heading: "メールアドレスを確認",
    body: "以下のコードを使用して Koinote アカウントの登録を完了してください。",
    expires: "このコードは 10 分後に期限切れになります。",
    ignore: "心当たりがない場合は、このメールを無視してください。",
  },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function normalizeLocale(value: unknown): Locale {
  return value === "zh" || value === "fr" || value === "ja" ? value : "en";
}

function emailContent(code: string, locale: Locale) {
  const message = copy[locale];
  return {
    subject: message.subject,
    html: `<!doctype html><html><body style="margin:0;padding:32px;background:#f7f4ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#211f1b"><div style="max-width:480px;margin:auto;padding:34px;border:1px solid #e5ded0;border-radius:18px;background:#fff"><div style="font-size:12px;font-weight:800;letter-spacing:2px;color:#b54235">KOINOTE</div><h1 style="margin:18px 0 10px;font-size:25px">${message.heading}</h1><p style="margin:0;color:#6a655d;line-height:1.7">${message.body}</p><div style="margin:26px 0;padding:18px;border-radius:12px;background:#211f1b;color:#f0c45c;text-align:center;font-size:34px;font-weight:800;letter-spacing:9px">${code}</div><p style="margin:0;color:#777169;font-size:13px">${message.expires}</p><p style="margin:12px 0 0;color:#9a948b;font-size:12px">${message.ignore}</p></div></body></html>`,
    text: `${message.heading}\n\n${message.body}\n\n${code}\n\n${message.expires}\n${message.ignore}`,
  };
}

function retryableEmailError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  return (
    code === "E_RATE_LIMIT_EXCEEDED" ||
    code === "E_DELIVERY_FAILED" ||
    code === "E_INTERNAL_SERVER_ERROR"
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function handleVerificationEmail(
  request: Request,
  env: EmailEnv,
): Promise<Response> {
  const expectedToken = (env.BACKEND_INTERNAL_TOKEN ?? "").trim();
  if (!expectedToken || !env.EMAIL) {
    return json(503, { code: "email_not_configured", error: "Email is not configured" });
  }
  const presentedToken = request.headers.get("x-koinote-internal-token") ?? "";
  if (!timingSafeEqual(presentedToken, expectedToken)) {
    return json(401, { code: "unauthorized", error: "Bad token" });
  }

  let body: { email?: unknown; code?: unknown; locale?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json(400, { code: "bad_request", error: "Invalid request" });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const code = typeof body.code === "string" ? body.code : "";
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 255 || !/^\d{6}$/.test(code)) {
    return json(400, { code: "bad_request", error: "Invalid email payload" });
  }

  const fromAddress = (env.EMAIL_FROM_ADDRESS ?? "").trim();
  if (!fromAddress) {
    return json(503, { code: "email_not_configured", error: "Sender is not configured" });
  }
  const content = emailContent(code, normalizeLocale(body.locale));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await env.EMAIL.send({
        to: email,
        from: { email: fromAddress, name: env.EMAIL_FROM_NAME?.trim() || "Koinote" },
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
      return json(200, { ok: true });
    } catch (error) {
      if (retryableEmailError(error) && attempt < 2) {
        await wait(250 * 2 ** attempt);
        continue;
      }
      console.error("verification email delivery failed", {
        code: error instanceof Error && "code" in error ? String(error.code) : "unknown",
      });
      return json(502, { code: "email_send_failed", error: "Email delivery failed" });
    }
  }
  return json(502, { code: "email_send_failed", error: "Email delivery failed" });
}
