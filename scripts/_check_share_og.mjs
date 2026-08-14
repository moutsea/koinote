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
} finally {
  globalThis.fetch = originalFetch;
}

console.log("share OpenGraph checks passed");
