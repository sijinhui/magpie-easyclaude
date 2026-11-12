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

test('malformed and oversized replies are rejected without exposing content', async () => {
  for (const body of ['<html>login</html>', 's'.repeat(1024 * 1024 + 1)]) {
    const plugin = createPlugin({ fetchImpl: async () => new Response(body) });
    const result = await plugin.auth.usage(auth);
    assert.ok(result.error);
    assert.equal(result.balance, undefined);
  }
});
