// This dedicated Worker has a single private origin, the Local backend.
const taskRoute = /^\/api\/writing-agent\/(mcp|callback)\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const requestHeaders = ['accept', 'content-type', 'authorization', 'mcp-protocol-version',
  'mcp-session-id', 'last-event-id', 'x-agent-timestamp', 'x-agent-signature', 'x-agent-delivery'];
const responseHeaders = ['content-type', 'mcp-session-id', 'www-authenticate', 'allow', 'retry-after'];

function pickHeaders(source, names) {
  const result = new Headers();
  for (const name of names) {
    if (source.has(name)) result.set(name, source.get(name));
  }
  return result;
}

export default {
  async fetch(request, env) {
    const { pathname, search } = new URL(request.url);
    const route = taskRoute.exec(pathname);
    if (!route || search) return new Response(null, { status: 404 });
    const allowed = route[1] === 'callback' ? ['POST'] : ['POST', 'GET', 'DELETE'];
    if (!allowed.includes(request.method)) return new Response(null, { status: 405, headers: { Allow: allowed.join(', ') } });

    // Koinote checks the task credential or webhook signature and bounds the
    // body. Never forward cookies, internal auth headers, redirects or upgrades.
    try {
      const response = await env.LOCAL_KOI.fetch(`https://koi-local.koinote.app${pathname}`, {
        method: request.method, headers: pickHeaders(request.headers, requestHeaders),
        body: request.body, redirect: 'manual', signal: request.signal,
      });
      const headers = pickHeaders(response.headers, responseHeaders);
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response('Local Koi is offline', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } });
    }
  },
};
