import test from 'node:test';
import assert from 'node:assert/strict';
import EasyClaudePlugin, { _internal } from '../index.mjs';

const { createPlugin, API, WEB, usageOf } = _internal;
const auth = async () => ({ type: 'api', key: 'sk-test-only' });
const info = { remain_quota: 18.59, used_quota: 1.41, total_quota: 20, key_flag: '小月卡', expired_time: '2026-12-12 11:35:59', api_key: 'must-not-be-returned' };
const response = data => Response.json({ status: 0, data });

function setup(options = {}) {
  const calls = [];
  const plugin = createPlugin({ ...options, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (options.respond) return options.respond(url, init, calls);
    return url.endsWith('/app/login') ? response({ session_token: 'session-test' }) : response(info);
  } });
  return { plugin, calls };
}

test('entry exposes one provider, metadata and single API key method', async () => {
  const plugin = await EasyClaudePlugin();
  const config = {};
  await plugin.config(config);
  assert.equal(plugin.auth.provider, 'easyclaude');
  assert.equal(plugin.auth.methods[0].type, 'api');
  assert.equal(config.provider.easyclaude.models['gpt-6.1-sol'].provider.npm, '@ai-sdk/openai');
  assert.equal(config.provider.easyclaude.models['claude-opus-5-5'].provider.npm, '@ai-sdk/anthropic');
  assert.ok(config.provider.easyclaude.models['gpt-6.1-sol'].limit.context > 0);
  config.provider.easyclaude.models['gpt-6.1-sol'].name = 'custom';
  await plugin.config(config);
  assert.equal(config.provider.easyclaude.models['gpt-6.1-sol'].name, 'custom');
});

test('one key logs in and reads sanitized amount and expiration', async () => {
  const { plugin, calls } = setup();
  const usage = await plugin.auth.usage(auth);
  assert.equal(usage.balance, '18.59');
  assert.equal(usage.windows[0].amount, 1.41);
  assert.equal(usage.windows[0].limit, 20);
  assert.equal(usage.until, '2026-12-12T03:35:59.000Z');
  assert.equal(usage.windows[0].resetsAt, undefined);
  assert.equal(usage.signIn, 'kept');
  assert.equal(JSON.stringify(usage).includes(info.api_key), false);
  assert.equal(calls[0].url, WEB + '/app/login');
  assert.deepEqual(JSON.parse(calls[0].init.body), { api_key: 'sk-test-only' });
  assert.equal(calls[1].init.headers.cookie, 'session_token=session-test');
  assert.deepEqual(JSON.parse(calls[1].init.body), { is_cache: 0 });
});

test('concurrent balance calls share one login', async () => {
  const { plugin, calls } = setup();
  await Promise.all(Array.from({ length: 5 }, () => plugin.auth.usage(auth)));
  assert.equal(calls.filter(call => call.url.endsWith('/app/login')).length, 1);
});

test('session cache is isolated by key and expires locally', async () => {
  let time = 0;
  const { plugin, calls } = setup({ now: () => time });
  await plugin.auth.usage(auth);
  await plugin.auth.usage(auth);
  await plugin.auth.usage(async () => ({ type: 'api', key: 'another-key' }));
  time += 24 * 3600000;
  await plugin.auth.usage(auth);
  assert.equal(calls.filter(call => call.url.endsWith('/app/login')).length, 3);
});

for (const expired of [() => new Response('', { status: 401 }), () => Response.json({ status: 1, info: '登录已过期' })]) {
  test('confirmed expired session relogs once', async () => {
    let queries = 0;
    const { plugin, calls } = setup({ respond: url => {
      if (url.endsWith('/app/login')) return response({ session_token: 'renewed-session' });
      return ++queries === 1 ? expired() : response(info);
    } });
    assert.equal((await plugin.auth.usage(auth)).balance, '18.59');
    assert.equal(calls.filter(call => call.url.endsWith('/app/login')).length, 2);
  });
}

test('repeated auth failure is bounded and keeps model sign-in', async () => {
  const { plugin, calls } = setup({ respond: url => url.endsWith('/app/login')
    ? response({ session_token: 'test' }) : new Response('', { status: 401 }) });
  const result = await plugin.auth.usage(auth);
  assert.equal(result.signIn, 'kept');
  assert.ok(result.error);
  assert.equal(result.balance, undefined);
  assert.equal(calls.length, 4);
});

test('rate limits do not trigger login loops', async () => {
  const { plugin, calls } = setup({ respond: url => url.endsWith('/app/login')
    ? response({ session_token: 'test' }) : new Response('', { status: 429 }) });
  assert.match((await plugin.auth.usage(auth)).error, /429/);
  assert.equal(calls.length, 2);
});

test('zero balance remains zero, missing amounts are errors', () => {
  assert.equal(usageOf({ ...info, remain_quota: 0, used_quota: 20 }).balance, '0.00');
  for (const bad of [undefined, null, '', 'not-a-number', true]) {
    assert.throws(() => usageOf({ ...info, remain_quota: bad }));
  }
});

test('transport errors cannot disclose credentials or clear auth', async () => {
  const { plugin } = setup({ respond: () => { throw Error('secret-key cookie=private'); } });
  const result = await plugin.auth.usage(auth);
  assert.ok(result.error);
  assert.equal(result.error.includes('secret-key'), false);
  assert.equal(result.signIn, 'kept');
});

test('streaming preserves request body tools signal status and upstream response', async () => {
  const upstream = new Response('event: message_start\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const calls = [];
  const plugin = createPlugin({ fetchImpl: async (url, init) => { calls.push({ url, init }); return upstream; } });
  const loader = await plugin.auth.loader(auth);
  const body = JSON.stringify({ model: 'claude-opus-5-5', stream: true, tools: [{ name: 'test', input_schema: { type: 'object' } }] });
  const signal = new AbortController().signal;
  const actual = await loader.fetch(API + '/messages', { method: 'POST', body, signal, headers: { cookie: 'private', 'x-magpie-session': 'internal', authorization: 'old', 'x-test': 'kept' } });
  assert.equal(actual, upstream);
  assert.equal(calls[0].init.body, body);
  assert.equal(calls[0].init.signal, signal);
  assert.equal(calls[0].init.headers.get('cookie'), null);
  assert.equal(calls[0].init.headers.get('x-magpie-session'), null);
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer sk-test-only');
  assert.equal(calls[0].init.headers.get('x-api-key'), 'sk-test-only');
  assert.equal(calls[0].init.headers.get('x-test'), 'kept');
  assert.equal(calls[0].init.redirect, 'error');
});

test('request objects and key changes work without loading cookies', async () => {
  const calls = [];
  const plugin = createPlugin({ fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response('ok'); } });
  let key = 'first';
  const loader = await plugin.auth.loader(async () => ({ type: 'api', key }));
  await loader.fetch(new Request(API + '/responses', { method: 'POST', body: '{}' }));
  key = 'second';
  await loader.fetch(API + '/responses', { method: 'POST', body: '{}' });
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer first');
  assert.equal(calls[1].init.headers.get('authorization'), 'Bearer second');
  assert.equal(calls[0].init.headers.get('x-api-key'), null);
  assert.ok(calls[0].init.body instanceof ReadableStream);
});

test('unknown origins paths and methods never receive credentials', async () => {
  const { plugin, calls } = setup();
  const loader = await plugin.auth.loader(auth);
  for (const url of ['https://example.com/v1/messages', WEB + '/app/login', API + '/unknown', 'http://jp.easyclaude.com/v1/messages', 'https://user@jp.easyclaude.com/v1/messages']) {
    await assert.rejects(loader.fetch(url, { method: 'POST' }));
  }
  await assert.rejects(loader.fetch(API + '/responses', { method: 'GET' }));
  assert.equal(calls.length, 0);
});

test('model listing respects actual account list and protocol metadata', async () => {
  const plugin = createPlugin({ fetchImpl: async () => Response.json({ data: [{ id: 'gpt-6.1-sol' }, { id: 'claude-opus-5-5' }] }) });
  const models = await plugin.provider.models({ models: { 'gpt-6.1-sol': { limit: { context: 1050000, output: 128000 } } } }, { auth: await auth() });
  assert.equal(Object.keys(models).length, 2);
  assert.equal(models['gpt-6.1-sol'].api.npm, '@ai-sdk/openai');
  assert.equal(models['claude-opus-5-5'].api.npm, '@ai-sdk/anthropic');
  assert.equal(models['gpt-6.1-sol'].limit.context, 1050000);
});

test('stream chunks arrive before completion without read-ahead or rewriting', async () => {
  const chunks = [
    new TextEncoder().encode('event: content_block_delta\ndata: {"partial_json":"'),
    new Uint8Array([0xe4, 0xbd]), // Chinese UTF-8 split across chunks
    new Uint8Array([0xa0, 0xe5, 0xa5, 0xbd]),
    new TextEncoder().encode('"}\n\nevent: message_stop\ndata: {}\n\n'),
  ];
  let pulls = 0;
  const upstream = new Response(new ReadableStream({
    pull(controller) {
      const i = pulls++;
      if (i < chunks.length) controller.enqueue(chunks[i]);
      else controller.close();
    },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  const plugin = createPlugin({ fetchImpl: async () => upstream });
  const loader = await plugin.auth.loader(auth);
  const result = await loader.fetch(API + '/messages', { method: 'POST', body: '{}' });
  assert.equal(result, upstream);
  assert.equal(pulls, 0, 'fetch returns without consuming upstream body');
  const reader = result.body.getReader();
  for (let i = 0; i < chunks.length; i++) {
    assert.deepEqual(await reader.read(), { value: chunks[i], done: false });
    assert.equal(pulls, i + 1, 'one downstream read consumes one upstream chunk');
  }
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
});

test('consumer cancel and upstream stream errors propagate unchanged', async () => {
  const reason = new Error('caller stopped');
  let canceled;
  const streamError = new Error('upstream disconnected');
  let controller;
  const replies = [
    new Response(new ReadableStream({ cancel(value) { canceled = value; } })),
    new Response(new ReadableStream({ start(value) { controller = value; } })),
  ];
  const plugin = createPlugin({ fetchImpl: async () => replies.shift() });
  const loader = await plugin.auth.loader(auth);
  const canceledResponse = await loader.fetch(API + '/messages', { method: 'POST' });
  await canceledResponse.body.cancel(reason);
  assert.equal(canceled, reason);
  const failedResponse = await loader.fetch(API + '/messages', { method: 'POST' });
  const reader = failedResponse.body.getReader();
  controller.error(streamError);
  await assert.rejects(reader.read(), error => error === streamError);
  reader.releaseLock();
});

test('already canceled requests do not read auth or contact upstream', async () => {
  let authCalls = 0;
  const { plugin, calls } = setup();
  const loader = await plugin.auth.loader(async () => { authCalls++; return auth(); });
  const controller = new AbortController();
  const reason = new Error('canceled before fetch');
  controller.abort(reason);
  await assert.rejects(loader.fetch(API + '/messages', {
    method: 'POST', signal: controller.signal,
  }), error => error === reason);
  assert.equal(authCalls, 1, 'only loader initialization reads auth');
  assert.equal(calls.length, 0);
});

test('cancel while auth is loading prevents a billed upstream call', async () => {
  const { plugin, calls } = setup();
  let notify, release;
  const started = new Promise(resolve => { notify = resolve; });
  const ready = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const loader = await plugin.auth.loader(async () => {
    if (++reads > 1) { notify(); await ready; }
    return auth();
  });
  const controller = new AbortController();
  const reason = new Error('canceled during auth');
  const pending = loader.fetch(API + '/messages', { method: 'POST', signal: controller.signal });
  await started;
  controller.abort(reason);
  release();
  await assert.rejects(pending, error => error === reason);
  assert.equal(calls.length, 0);
});

test('network failures propagate unchanged without retries and cancellation keeps its reason', async () => {
  let calls = 0;
  const controller = new AbortController();
  const reason = new Error('caller canceled');
  const cause = new Error('connection reset');
  const networkError = new TypeError('fetch failed', { cause });
  const plugin = createPlugin({ fetchImpl: async () => {
    if (++calls === 2) controller.abort(reason);
    controller.signal.throwIfAborted();
    throw networkError;
  } });
  const loader = await plugin.auth.loader(auth);
  await assert.rejects(loader.fetch(API + '/responses', { method: 'POST' }), error => {
    assert.equal(error, networkError);
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(loader.fetch(API + '/responses', {
    method: 'POST', signal: controller.signal,
  }), error => error === reason);
  assert.equal(calls, 2);
});

test('HTTP errors preserve status headers and body without retries', async () => {
  for (const status of [400, 401, 429, 500, 503]) {
    const upstream = new Response('{"error":"upstream failure"}', {
      status, headers: { 'retry-after': '30', 'request-id': 'request-test' },
    });
    let calls = 0;
    const plugin = createPlugin({ fetchImpl: async () => { calls++; return upstream; } });
    const loader = await plugin.auth.loader(auth);
    const result = await loader.fetch(API + '/responses', { method: 'POST' });
    assert.equal(result, upstream);
    assert.equal(result.status, status);
    assert.equal(result.headers.get('retry-after'), '30');
    assert.equal(result.headers.get('request-id'), 'request-test');
    assert.equal(await result.text(), '{"error":"upstream failure"}');
    assert.equal(calls, 1);
  }
});

test('Request overrides preserve body and signal while disabling ambient credentials', async () => {
  const { plugin, calls } = setup({ respond: () => new Response('ok') });
  const loader = await plugin.auth.loader(auth);
  const controller = new AbortController();
  const input = new Request(API + '/messages', {
    method: 'POST', body: 'old', credentials: 'include', headers: { cookie: 'private' },
  });
  await loader.fetch(input, { body: 'new', signal: controller.signal, credentials: 'include' });
  const options = calls[0].init;
  assert.equal(options.credentials, 'omit');
  assert.equal(options.headers.get('cookie'), null);
  assert.equal(await new Response(options.body).text(), 'new');
  const reason = new Error('abort Request signal');
  controller.abort(reason);
  assert.equal(options.signal.aborted, true);
  assert.equal(options.signal.reason, reason);
  await plugin.auth.usage(auth);
  for (const call of calls) assert.equal(call.init.credentials, 'omit');
});

test('the final rejected balance session is not reused on the next query', async () => {
  let logins = 0, queries = 0;
  const { plugin } = setup({ respond: url => {
    if (url.endsWith('/app/login')) return response({ session_token: `session-${++logins}` });
    return ++queries <= 2 ? new Response('', { status: 401 }) : response(info);
  } });
  assert.match((await plugin.auth.usage(auth)).error, /401/);
  assert.equal(logins, 2);
  assert.equal((await plugin.auth.usage(auth)).balance, '18.59');
  assert.equal(logins, 3, 'next query logs in instead of reusing the last rejected cookie');
  assert.equal(queries, 3);
});

test('model listing skips bad entries and normalizes names without inherited defaults', async () => {
  const plugin = createPlugin({ fetchImpl: async () => Response.json({ data: [
    null, {}, { id: 123 }, { id: '../invalid' },
    { id: 'constructor', name: { unexpected: true } },
    { id: 'new-model', name: '   ' },
    { id: 'claude-opus-5-5', name: 'Claude' },
  ] }) });
  const models = await plugin.provider.models({ models: {} }, { auth: await auth() });
  assert.deepEqual(Object.keys(models), ['constructor', 'new-model', 'claude-opus-5-5']);
  assert.equal(models.constructor.name, 'constructor');
  assert.equal(models.constructor.limit.context, 0);
  assert.equal(models['new-model'].name, 'new-model');
  assert.equal(models['claude-opus-5-5'].name, 'Claude');
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(models))), Object.keys(models));
});

test('malformed and oversized replies are rejected without exposing content', async () => {
  for (const body of ['<html>login</html>', 's'.repeat(1024 * 1024 + 1)]) {
    const plugin = createPlugin({ fetchImpl: async () => new Response(body) });
    const result = await plugin.auth.usage(auth);
    assert.ok(result.error);
    assert.equal(result.balance, undefined);
  }
});
