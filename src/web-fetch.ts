import { Type } from 'typebox';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

const MAX_RESPONSE_BYTES = 256_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|.*token.*|.*secret.*|.*password.*)$/i;
const FORBIDDEN_HEADER = /^(cookie|set-cookie)$/i;

export const WebFetchSchema = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 4000 }),
  method: Type.String({ enum: ['GET', 'HEAD', 'POST'] }),
  headers: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 200 }), Type.String({ maxLength: 4000 }))),
  headerRefs: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 200 }), Type.String({ minLength: 1, maxLength: 200 }))),
  body: Type.Optional(Type.Unknown()),
  purpose: Type.String({ minLength: 1, maxLength: 1000 }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: MAX_TIMEOUT_MS })),
});

export type WebFetchParams = {
  url: string;
  method: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  headerRefs?: Record<string, string>;
  body?: unknown;
  purpose: string;
  timeoutMs?: number;
};

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

function resolveHeaderRef(value: string): string {
  const name = value.startsWith('$') ? value.slice(1) : value;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('headerRefs 只能引用环境变量名。');
  const resolved = process.env[name];
  if (!resolved) throw new Error(`找不到认证环境变量 ${name}。`);
  return resolved;
}

function validateUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('url不是有效的HTTP(S)地址。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('web_fetch只允许HTTP(S)地址。');
  if (url.username || url.password) throw new Error('url不得内嵌用户名或密码。');
  return url;
}

export async function webFetch(params: WebFetchParams, signal?: AbortSignal) {
  const url = validateUrl(params.url);
  const headers = new Headers();
  for (const [name, value] of Object.entries(params.headers ?? {})) {
    if (FORBIDDEN_HEADER.test(name)) throw new Error(`不允许由web_fetch设置Header ${name}。`);
    if (SENSITIVE_HEADER.test(name)) throw new Error(`敏感Header ${name} 必须通过headerRefs引用环境变量，不能明文传入。`);
    headers.set(name, value);
  }
  for (const [name, ref] of Object.entries(params.headerRefs ?? {})) {
    if (FORBIDDEN_HEADER.test(name)) throw new Error(`不允许由web_fetch设置Header ${name}。`);
    headers.set(name, resolveHeaderRef(ref));
  }

  let body: string | undefined;
  if (params.method === 'HEAD' || params.method === 'GET') {
    if (params.body !== undefined) throw new Error(`${params.method}请求不接受body。`);
  } else if (params.body !== undefined) {
    if (typeof params.body === 'string') body = params.body;
    else {
      body = JSON.stringify(params.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
  }

  const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeout, MAX_TIMEOUT_MS));
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, { method: params.method, headers, body, redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) throw new Error(`服务器返回重定向(${response.status})，web_fetch不自动跟随重定向。`);
    if (params.method === 'HEAD') return { status: response.status, contentType: response.headers.get('content-type'), body: '', externalData: true, purpose: params.purpose };
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > MAX_RESPONSE_BYTES) throw new Error(`响应超过${MAX_RESPONSE_BYTES}字节上限。`);
    return { status: response.status, contentType: response.headers.get('content-type'), body: new TextDecoder().decode(data), externalData: true, purpose: params.purpose };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('web_fetch请求超时或已取消。');
    throw new Error(`web_fetch请求失败：${safeError(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function webFetchDescription(): string {
  return '受控HTTP信息读取：支持GET/HEAD/POST查询、自定义普通Header和通过环境变量引用的认证Header。禁止文件上传、Cookie、响应执行；响应标记为外部数据。purpose仅记录调用意图，不是安全证明。';
}
