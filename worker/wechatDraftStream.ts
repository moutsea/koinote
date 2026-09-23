export const WECHAT_DRAFT_STREAM_TYPE = "application/x-koinote-wechat-draft";

const MAX_STREAM_BYTES = 64 * 1024;

export async function readWechatDraftResponse(
  response: Response,
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-koinote-proxy", "cloudflare-worker");
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  const reader = response.body?.getReader();
  try {
    if (!reader) throw new Error("missing draft response stream");
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let pending = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("draft stream ended without a result");
      totalBytes += value.byteLength;
      if (totalBytes > MAX_STREAM_BYTES) {
        throw new Error("draft response stream exceeded its limit");
      }
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (frame?.type === "ping") continue;
        if (
          frame?.type !== "result" ||
          !Number.isInteger(frame.status) ||
          (frame.status !== 200 && (frame.status < 400 || frame.status > 599)) ||
          !frame.body ||
          typeof frame.body !== "object" ||
          Array.isArray(frame.body)
        ) {
          throw new Error("invalid draft response frame");
        }
        if (
          frame.status === 200 &&
          (typeof frame.body.draft?.mediaId !== "string" || !frame.body.draft.mediaId.trim())
        ) {
          throw new Error("draft response omitted the created draft");
        }
        return new Response(JSON.stringify(frame.body), {
          status: frame.status,
          headers,
        });
      }
    }
  } catch {
    return new Response(
      JSON.stringify({
        code: "wechat_provider_unavailable",
        error: "WeChat draft response was interrupted. Check the draft box before retrying.",
      }),
      { status: 502, headers },
    );
  } finally {
    await reader?.cancel().catch(() => {});
  }
}
