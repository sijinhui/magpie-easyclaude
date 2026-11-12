import { createHash } from 'node:crypto';
import { modelDefaults } from './models.mjs';

const PROVIDER = 'easyclaude';
const API = 'https://jp.easyclaude.com/v1';
const WEB = 'https://easyclaude.com';
const SESSION_TTL = 23 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 1024 * 1024;
const REQUEST_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens', '/v1/responses', '/v1/chat/completions']);

class ServiceError extends Error {
  constructor(message, sessionExpired = false) {
    super(message);
    this.sessionExpired = sessionExpired;
  }
}

function apiKey(auth) {
  if (auth?.type !== 'api' || typeof auth.key !== 'string' || !auth.key.trim()) {
    throw new ServiceError('请在 EasyClaude 供应商中配置 API Key');
  }
  const key = auth.key.trim();
  if (/[\r\n]/.test(key)) throw new ServiceError('API Key 格式不正确');
  return key;
}

function sessionId(key) {
  return createHash('sha256').update(key).digest('hex');
}

function modelPackage(id) {
  if (id.startsWith('claude-')) return '@ai-sdk/anthropic';
  if (id.startsWith('gpt-')) return '@ai-sdk/openai';
  return '@ai-sdk/openai-compatible';
}

function safeNumber(value, name) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw new ServiceError(`余额回复缺少 ${name}，未按零处理`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ServiceError(`余额回复的 ${name} 不是有效数字`);
  return number;
}

function expiry(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + '+08:00' : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function usageOf(data) {
  const remaining = safeNumber(data?.remain_quota, 'remain_quota');
  const used = safeNumber(data?.used_quota, 'used_quota');
  const total = safeNumber(data?.total_quota, 'total_quota');
  if (total <= 0 || used < 0) throw new ServiceError('余额回复的总额度或已用额度无效');
  const until = expiry(data.expired_time);
  const plan = typeof data.key_flag === 'string' ? data.key_flag.slice(0, 80) : 'EasyClaude';
  return {
    plan,
    balance: remaining.toFixed(2),
    ...(until ? { until } : {}),
    windows: [{
      name: '套餐额度',
      used: used / total * 100,
      amount: used,
      limit: total,
      unit: '额度',
      display: `剩余 ${remaining.toFixed(2)} · 已用 ${used.toFixed(2)} / ${total.toFixed(2)}`,
      ...(until ? { runsOutAt: until, runsOut: Math.max(0, remaining) } : {}),
    }],
    signIn: 'kept',
  };
}

async function jsonResponse(response, label, webEnvelope = true) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ServiceError(`${label}失败（HTTP ${response.status}）`, response.status === 401 || response.status === 403);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceError(`${label}未返回数据`);
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new ServiceError(`${label}回复过大`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ServiceError(`${label}未返回有效 JSON，可能需要重新登录或站点存在验证页`); }
  if (webEnvelope && result?.status !== 0) {
    const expired = /未登录|登录.*(失效|过期)|会话.*(失效|过期)|not.?logged|session.*expir|unauthenticated/i.test(String(result?.info ?? ''));
    throw new ServiceError(expired ? 'EasyClaude 余额会话失效' : `${label}被站点拒绝`, expired);
  }
  return result;
}

function createPlugin({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const sessions = new Map();
  const logins = new Map();

  async function request(url, init, label, webEnvelope = true) {
    try {
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) });
      return await jsonResponse(response, label, webEnvelope);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(`${label}连接失败或超时，请检查网络或代理`);
    }
  }

  async function session(key) {
    const id = sessionId(key);
    const cached = sessions.get(id);
    if (cached && cached.until > now()) return cached;
    if (logins.has(id)) return logins.get(id);
    const pending = (async () => {
      const result = await request(`${WEB}/app/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: key }),
      }, 'EasyClaude 登录');
      const token = result?.data?.session_token;
      if (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,2048}$/.test(token)) {
        throw new ServiceError('EasyClaude 登录未返回有效会话');
      }
      const value = { token, until: now() + SESSION_TTL };
      sessions.set(id, value);
      if (sessions.size > 64) sessions.delete(sessions.keys().next().value);
      return value;
    })();
    logins.set(id, pending);
    try { return await pending; } finally { logins.delete(id); }
  }

  async function readBalance(key) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await session(key);
      try {
        const result = await request(`${WEB}/v1/app_web/key/info`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: `session_token=${current.token}` },
          body: JSON.stringify({ is_cache: 0 }),
        }, 'EasyClaude 余额查询');
        return usageOf(result.data);
      } catch (error) {
        if (!error.sessionExpired || attempt > 0) throw error;
        if (sessions.get(sessionId(key)) === current) sessions.delete(sessionId(key));
      }
    }
  }

  return {
    config: async config => {
      config.provider ??= {};
      config.provider[PROVIDER] ??= {};
      const provider = config.provider[PROVIDER];
      provider.name ??= 'EasyClaude';
      provider.npm ??= '@ai-sdk/openai';
      provider.api ??= API;
      provider.models ??= {};
      for (const id of Object.keys(modelDefaults)) {
        provider.models[id] ??= { ...modelDefaults[id], provider: { npm: modelPackage(id), api: API } };
      }
    },
    auth: {
      provider: PROVIDER,
      methods: [{ type: 'api', label: 'EasyClaude API Key（模型与余额共用）', placeholder: 'sk-…' }],
      async loader(getAuth) {
        return {
          apiKey: apiKey(await getAuth()),
          async fetch(input, init = {}) {
            const request = input instanceof Request ? new Request(input, init) : null;
            const url = new URL(request ? request.url : String(input));
            const method = request?.method ?? init.method ?? 'GET';
            if (url.origin !== new URL(API).origin || url.username || url.password || url.hash
              || !REQUEST_PATHS.has(url.pathname) || method.toUpperCase() !== 'POST') {
              throw new ServiceError('EasyClaude 插件拒绝向非指定日本节点或未知接口发送密钥');
            }
            const key = apiKey(await getAuth());
            const headers = new Headers(request ? request.headers : init.headers);
            for (const name of [...headers.keys()]) {
              if (['authorization', 'x-api-key', 'cookie', 'host', 'content-length', 'origin', 'referer', 'proxy-authorization'].includes(name) || name.startsWith('x-magpie-')) headers.delete(name);
            }
            headers.set('authorization', `Bearer ${key}`);
            if (url.pathname.startsWith('/v1/messages')) {
              headers.set('x-api-key', key);
              if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
            }
            const options = { ...init, method, headers, redirect: 'error', signal: request?.signal ?? init.signal };
            if (request) options.body = request.body;
            if (options.body instanceof ReadableStream) options.duplex = 'half';
            return fetchImpl(url.href, options);
          },
        };
      },
      async usage(getAuth) {
        try { return await readBalance(apiKey(await getAuth())); }
        catch (error) {
          return { error: error instanceof ServiceError ? error.message : 'EasyClaude 余额读取失败', windows: [], signIn: 'kept' };
        }
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (auth?.type !== 'api') return provider.models;
        const key = apiKey(auth);
        const result = await request(`${API}/models`, {
          headers: { authorization: `Bearer ${key}`, 'x-api-key': key },
        }, 'EasyClaude 模型列表', false);
        if (!Array.isArray(result?.data) || !result.data.length) throw new ServiceError('EasyClaude 模型列表为空或格式错误');
        const models = {};
        for (const item of result.data) {
          if (typeof item?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(item.id)) continue;
          const id = item.id;
          const previous = provider.models?.[id] ?? {};
          models[id] = {
            ...previous, id, providerID: PROVIDER, name: item.name ?? id, status: 'active',
            api: { id, url: API, npm: modelPackage(id) },
            limit: previous.limit ?? { context: 0, output: 0 },
            capabilities: previous.capabilities ?? { toolcall: true, input: { text: true }, output: { text: true } },
          };
        }
        if (!Object.keys(models).length) throw new ServiceError('EasyClaude 没有可用的模型标识');
        return models;
      },
    },
  };
}

export default async function EasyClaudePlugin() { return createPlugin(); }
export const _internal = { createPlugin, usageOf, expiry, API, WEB };
