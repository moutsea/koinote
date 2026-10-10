const PREFIX = "/api/internal/agent-repository-objects/";
const MAX_BYTES = 5 * 1024 * 1024;
const KEY = /^objects\/[0-9a-f]{32}\/([0-9a-f]{64})$/;

type RepositoryObjectsEnv = Pick<Cloudflare.Env, "AGENT_REPOSITORIES"> & {
  BACKEND_INTERNAL_TOKEN?: string;
};

function reply(status: number, code: string): Response {
  return Response.json({ code }, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function authorized(request: Request, env: RepositoryObjectsEnv): Promise<boolean> {
  const expected = env.BACKEND_INTERNAL_TOKEN?.trim() ?? "";
  if (!expected) return false;
  const encoder = new TextEncoder();
  const digests = await Promise.all([expected, request.headers.get("x-koinote-internal-token") ?? ""].map(value => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  const left = new Uint8Array(digests[0]), right = new Uint8Array(digests[1]);
  let difference = 0;
  for (let index = 0; index < 32; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

// Repository contents are never served through a public bucket/domain. The Go
// service checks the user or published revision before calling this private API.
export async function handleAgentRepositoryObject(request: Request, env: RepositoryObjectsEnv): Promise<Response> {
  if (!await authorized(request, env)) return reply(401, "unauthorized");
  if (!env.AGENT_REPOSITORIES) return reply(503, "repository_storage_unavailable");
  const url = new URL(request.url);
  if (url.pathname === `${PREFIX}health` && request.method === "GET") {
    try {
      await env.AGENT_REPOSITORIES.head("__healthcheck__");
      return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
    } catch { return reply(502, "repository_storage_unavailable"); }
  }
  const key = url.pathname.slice(PREFIX.length);
  const match = KEY.exec(key);
  if (!url.pathname.startsWith(PREFIX) || !match) return reply(400, "invalid_object_key");
  const sha256 = match[1];
  try {
    if (request.method === "PUT") {
      const rawLength = request.headers.get("content-length");
      if (rawLength === null || !/^\d+$/.test(rawLength)) return reply(411, "content_length_required");
      const size = Number(rawLength);
      if (!Number.isSafeInteger(size) || size > MAX_BYTES) return reply(413, "object_too_large");
      // Bound actual bytes as well as the advertised length, including chunked
      // or malformed callers. At most one 5 MiB file is buffered per request.
      const bytes = new Uint8Array(size);
      const reader = request.body?.getReader();
      let offset = 0;
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (offset + value.byteLength > size) {
              await reader.cancel();
              return reply(413, "object_too_large");
            }
            bytes.set(value, offset);
            offset += value.byteLength;
          }
        } finally { reader.releaseLock(); }
      }
      if (offset !== size) return reply(400, "object_size_mismatch");
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
      if (digest !== sha256) return reply(400, "object_checksum_mismatch");
      const object = await env.AGENT_REPOSITORIES.put(key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256,
        httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" },
        customMetadata: { sha256 },
      });
      // An uncertain upload may be retried, but existing objects are immutable.
      const stored = object ?? await env.AGENT_REPOSITORIES.head(key);
      if (!stored || stored.size !== size || stored.customMetadata?.sha256 !== sha256) return reply(409, "object_conflict");
      return reply(200, "stored");
    }
    if (request.method === "DELETE") {
      await env.AGENT_REPOSITORIES.delete(key);
      return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
    }
    if (request.method === "GET") {
      const offsetRaw = url.searchParams.get("offset") ?? "0";
      const lengthRaw = url.searchParams.get("length") ?? String(MAX_BYTES);
      if (!/^\d+$/.test(offsetRaw) || !/^\d+$/.test(lengthRaw)) return reply(400, "invalid_range");
      const offset = Number(offsetRaw), length = Number(lengthRaw);
      if (!Number.isSafeInteger(offset) || offset > MAX_BYTES || !Number.isSafeInteger(length) || length > MAX_BYTES) return reply(400, "invalid_range");
      if (length === 0) {
        const object = await env.AGENT_REPOSITORIES.head(key);
        if (!object) return reply(404, "object_not_found");
        if (offset !== 0 || object.size !== 0 || object.customMetadata?.sha256 !== sha256) return reply(416, "invalid_range");
        return new Response(null, { headers: { "Content-Length": "0", "Cache-Control": "private, no-store", "X-Koinote-Object-Sha256": sha256 } });
      }
      const object = await env.AGENT_REPOSITORIES.get(key, { range: { offset, length } });
      if (!object) return reply(404, "object_not_found");
      if (object.customMetadata?.sha256 !== sha256) return reply(502, "object_checksum_mismatch");
      return new Response(object.body, { headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(object.range && "length" in object.range ? object.range.length ?? object.size : object.size),
        "Cache-Control": "private, no-store",
        "X-Koinote-Object-Sha256": sha256,
        "X-Content-Type-Options": "nosniff",
      } });
    }
    return reply(405, "method_not_allowed");
  } catch {
    console.error("repository R2 operation failed", { method: request.method });
    return reply(502, "repository_storage_unavailable");
  }
}
