import assert from "node:assert/strict";
import worker from "./_share_og_bundle.mjs";

const token = "0123456789abcdef0123456789abcdef";
const baseHTML =
  '<!doctype html><html><head><title>Koinote</title><meta name="description" content="base"></head><body></body></html>';
const originalFetch = globalThis.fetch;

function env() {
  return {
    BACKEND_URL: "https://backend.example",
    BACKEND_INTERNAL_TOKEN: "internal",
    IMAGE_PUBLIC_BASE: "https://img.koinote.app",
    ASSETS: {
      fetch: async () =>
        new Response(baseHTML, { headers: { "content-type": "text/html" } }),
    },
  };
}

try {
  const downloadResponse = await worker.fetch(
    new Request("https://koinote.app/download"),
    env(),
  );
  assert.equal(downloadResponse.status, 302);
  assert.equal(
    downloadResponse.headers.get("location"),
    "https://github.com/moutsea/koinote/releases/latest",
  );

  globalThis.fetch = async (request) => {
    assert.equal(
      new URL(request.url ?? request).pathname,
      `/api/share/${token}/meta`,
    );
    return Response.json({
      title: '标题 <"测试">；论文 $` / $& 笔记',
      description: "摘要 & 内容；公式 $$E=mc^2$$ 与价格 $$100",
      imageKey: "u/user_1/0123456789abcdef.png",
      protected: false,
    });
  };
  const publicResponse = await worker.fetch(
    new Request(`https://koinote.app/share/${token}`),
    env(),
  );
  const publicHTML = await publicResponse.text();
  assert.match(
    publicHTML,
    /<title>标题 &lt;&quot;测试&quot;&gt;；论文 \$` \/ \$&amp; 笔记 — Koinote<\/title>/,
  );
  assert.ok(
    publicHTML.includes(
      'property="og:description" content="摘要 &amp; 内容；公式 $$E=mc^2$$ 与价格 $$100"',
    ),
  );
  assert.equal((publicHTML.match(/<!doctype html>/gi) ?? []).length, 1);
  assert.match(
    publicHTML,
    /property="og:image" content="https:\/\/img\.koinote\.app\/u\/user_1\/0123456789abcdef\.png"/,
  );
  assert.equal(
    publicResponse.headers.get("cache-control"),
    "private, no-store",
  );

  globalThis.fetch = async () =>
    Response.json({
      protected: true,
      title: "绝密标题",
      description: "绝密正文",
    });
  const protectedResponse = await worker.fetch(
    new Request(`https://koinote.app/share/${token}`),
    env(),
  );
  const protectedHTML = await protectedResponse.text();
  assert.match(protectedHTML, /受保护的 Koinote 文档/);
  assert.doesNotMatch(protectedHTML, /绝密/);

  let backendCalls = 0;
  globalThis.fetch = async () => { backendCalls++; throw new Error("must not reach backend"); };
  const deniedEnv = { ...env(), SHARE_READ_LIMITER: { limit: async ({ key }) => {
    assert.equal(key, "koinote:share:192.0.2.55");
    return { success: false };
  } } };
  for (const [method, path] of [
    ["GET", `/share/${token}`], ["HEAD", `/share/${token}`],
    ["GET", `/api/share/${token}`], ["GET", `/api/share/${token}/meta`],
    ["POST", `/api/share/${token}/verify`],
  ]) {
    const response = await worker.fetch(new Request(`https://koinote.app${path}`, {
      method, headers: { "cf-connecting-ip": "192.0.2.55", "x-forwarded-for": "forged" },
    }), deniedEnv);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    if (path.startsWith("/share/")) {
      assert.match(response.headers.get("content-type"), /text\/html/);
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
      assert.ok(response.headers.has("content-security-policy"));
      const body = await response.text();
      if (method === "HEAD") assert.equal(body, "");
      else {
        assert.match(body, /<main>/);
        assert.ok(body.includes(`href="/share/${token}"`));
        assert.doesNotMatch(body, /<script|绝密/);
      }
    } else {
      assert.match(response.headers.get("content-type"), /application\/json/);
      assert.equal((await response.json()).code, "too_many_requests");
    }
  }
  assert.equal(backendCalls, 0);
  // Rotating addresses inside one IPv6 /64 must land in the same edge bucket.
  const ipv6Keys = [];
  const ipv6Env = { ...env(), SHARE_READ_LIMITER: { limit: async ({ key }) => { ipv6Keys.push(key); return { success: false }; } } };
  for (const address of ["2001:db8:5:6::1", "2001:db8:5:6:ffff::9"]) {
    await worker.fetch(new Request(`https://koinote.app/api/share/${token}`, { headers: { "cf-connecting-ip": address } }), ipv6Env);
  }
  assert.deepEqual(ipv6Keys, ["koinote:share:2001:db8:5:6::/64", "koinote:share:2001:db8:5:6::/64"]);
  const limiterDown = await worker.fetch(new Request(`https://koinote.app/api/share/${token}`), {
    ...env(), SHARE_READ_LIMITER: { limit: async () => { throw new Error("binding unavailable"); } },
  });
  assert.equal(limiterDown.status, 503);
  assert.equal((await limiterDown.json()).code, "share_unavailable");
  for (const locale of ["zh", "en", "fr", "ja"]) {
    const unavailable = await worker.fetch(new Request(`https://koinote.app/share/${token}`, {
      headers: { "accept-language": `${locale}-XX,en;q=0.5` },
    }), {
      ...env(), SHARE_READ_LIMITER: { limit: async () => { throw new Error("unavailable"); } },
      ASSETS: { fetch: async () => { throw new Error("must not load assets"); } },
    });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("content-language"), locale);
    assert.match(await unavailable.text(), new RegExp(`<html lang="${locale}">`));
  }
  assert.equal(backendCalls, 0);

  globalThis.fetch = async (_request, init) => {
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).get("x-forwarded-for"), "192.0.2.55");
    return Response.json({ protected: true });
  };
  const allowed = { ...env(), SHARE_READ_LIMITER: { limit: async () => ({ success: true }) } };
  assert.equal((await worker.fetch(new Request(`https://koinote.app/share/${token}`, {
    headers: { "cf-connecting-ip": "192.0.2.55" },
  }), allowed)).status, 200);

  // Exercise the real timeout signal without contacting an origin.
  let aborted = false;
  globalThis.fetch = async (_request, init) => new Promise((_resolve, reject) => {
    const watchdog = setTimeout(() => reject(new Error("share fetch did not abort")), 6_000);
    init.signal.addEventListener("abort", () => {
      aborted = true;
      clearTimeout(watchdog);
      reject(init.signal.reason);
    }, { once: true });
  });
  const timedOut = await worker.fetch(new Request(`https://koinote.app/api/share/${token}`), allowed);
  assert.equal(aborted, true);
  assert.equal(timedOut.status, 503);
  assert.equal((await timedOut.json()).code, "share_unavailable");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("share OpenGraph checks passed");
