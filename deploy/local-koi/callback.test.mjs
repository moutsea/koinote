import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './callback.mjs';

const base = 'https://koi-local.koinote.app';
const id = '00000000-0000-4000-8000-000000000000';
test('only exact task routes reach the local backend', async () => {
  for (const path of ['/health', '/api/agent/sessions', '/api/writing-agent/mcp/no-id',
    `/api/writing-agent/mcp/${id}/extra`, `/api/writing-agent/mcp/${id}?to=/api/admin`]) {
    assert.equal((await worker.fetch(new Request(base + path), {})).status, 404);
  }
  assert.equal((await worker.fetch(new Request(`${base}/api/writing-agent/callback/${id}`), {})).status, 405);
});

test('task credentials and signed callback bytes survive forwarding, app credentials do not', async () => {
  for (const route of ['mcp', 'callback']) {
    const path = `/api/writing-agent/${route}/${id}`;
    const body = '{"message":"原文"}\n';
    const request = new Request(base + path, { method: 'POST', body, headers: {
      authorization: 'Bearer fixture', 'x-agent-signature': 'fixture', cookie: 'private', 'x-koinote-internal-token': 'untrusted',
    } });
    let calls = 0;
    const res = await worker.fetch(request, { LOCAL_KOI: { async fetch(url, init) {
      calls++;
      assert.equal(url, `https://koi-local.koinote.app${path}`);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.get('authorization'), 'Bearer fixture');
      assert.equal(init.headers.get('x-agent-signature'), 'fixture');
      assert.equal(init.headers.has('cookie') || init.headers.has('x-koinote-internal-token'), false);
      assert.equal(await new Response(init.body).text(), body);
      return new Response('ok', { headers: { 'set-cookie': 'private', 'mcp-session-id': 'session' } });
    } } });
    assert.equal(calls, 1);
    assert.equal(await res.text(), 'ok');
    assert.equal(res.headers.get('mcp-session-id'), 'session');
    assert.equal(res.headers.get('set-cookie'), null);
  }
});
