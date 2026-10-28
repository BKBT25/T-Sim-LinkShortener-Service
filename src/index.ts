/**
 * T-Sim · servicio de enlaces cortos (Cloudflare Worker + KV).
 *
 * El enlace largo es **autónomo**: el circuito viaja comprimido en el hash
 * (`#p=…`). Este Worker solo guarda «código → enlace largo» y redirige; no
 * interpreta circuitos ni necesita la app para funcionar.
 *
 * Rutas:
 * - `POST /api/shorten { url }` → `{ code, short, expiresAt }` (30 días).
 * - `GET  /s/:code`            → `302` al enlace largo.
 * - `GET  /health`             → `{ ok: true }` (monitorización).
 * - `GET  /`                   → `302` a la app (primer origen permitido).
 *
 * Seguridad: solo acepta URLs de los orígenes permitidos (evita el *open
 * redirect*), con hash `#p=` válido, límite de tamaño, límite de peticiones por
 * IP y códigos deterministas derivados de SHA-256.
 */

export interface KvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Env {
  LINKS: KvNamespace;
  /** Orígenes de la app separados por comas (p. ej. `https://t-sim.tlanextlilabs.com`). */
  APP_ORIGINS?: string;
  /** Compatibilidad: un único origen de la app. */
  APP_ORIGIN?: string;
  /** Vida del enlace corto en segundos (por defecto 30 días). */
  LINK_TTL_SECONDS?: string;
  /** Peticiones de creación permitidas por minuto y por IP. */
  RATE_LIMIT_PER_MINUTE?: string;
}

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_RATE_LIMIT = 20;
const MAX_BODY_BYTES = 64 * 1024;
const CODE_LENGTH = 10;
const CODE_PATTERN = /^[A-Za-z0-9_-]{4,32}$/;
const PAYLOAD_PATTERN = /^#p=[zu][A-Za-z0-9_-]{16,}$/;

function ttlSeconds(env: Env): number {
  const parsed = Number(env.LINK_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : DEFAULT_TTL_SECONDS;
}

function rateLimit(env: Env): number {
  const parsed = Number(env.RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : DEFAULT_RATE_LIMIT;
}

/** Orígenes permitidos, normalizados y sin duplicados. */
export function allowedOrigins(env: Env): string[] {
  const raw = `${env.APP_ORIGINS ?? ''},${env.APP_ORIGIN ?? ''}`;
  const origins = raw
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter((value) => value !== '');
  return [...new Set(origins)];
}

function corsHeaders(env: Env, request?: Request): Record<string, string> {
  const allowed = allowedOrigins(env);
  const origin = request?.headers.get('origin') ?? '';
  const allow = allowed.includes(origin) ? origin : allowed[0] ?? '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, env: Env, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(env, request),
    },
  });
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Código determinista y corto para un enlace (mismo circuito → mismo código). */
export async function codeForLink(url: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return base64Url(digest).slice(0, CODE_LENGTH);
}

function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'local';
}

function sameOriginTarget(raw: string, env: Env): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_BODY_BYTES) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!allowedOrigins(env).includes(parsed.origin)) return null;
  if (!PAYLOAD_PATTERN.test(parsed.hash)) return null;
  return parsed.toString();
}

export async function handleShorten(request: Request, env: Env): Promise<Response> {
  if (allowedOrigins(env).length === 0) {
    return json({ error: 'Falta configurar APP_ORIGINS en el Worker.' }, 500, env, request);
  }
  const ip = clientIp(request);
  const windowKey = `rl:${ip}:${Math.floor(Date.now() / 60_000)}`;
  const used = Number((await env.LINKS.get(windowKey)) ?? '0');
  if (used >= rateLimit(env)) {
    return json({ error: 'Demasiadas peticiones; espera un minuto.' }, 429, env, request);
  }
  await env.LINKS.put(windowKey, String(used + 1), { expirationTtl: 120 });

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return json({ error: 'El enlace es demasiado largo.' }, 413, env, request);
  }
  let body: { url?: unknown; payload?: unknown };
  try {
    body = JSON.parse(text) as { url?: unknown; payload?: unknown };
  } catch {
    return json({ error: 'Cuerpo JSON inválido.' }, 400, env, request);
  }
  const origin = allowedOrigins(env)[0];
  const candidate =
    typeof body.url === 'string'
      ? body.url
      : typeof body.payload === 'string' && body.payload.startsWith('#p=')
        ? `${origin}/${body.payload}`
        : null;
  const target = candidate ? sameOriginTarget(candidate, env) : null;
  if (!target) {
    return json(
      {
        error:
          'Solo se acortan enlaces de T-Sim con el circuito en el hash (#p=…). Comprueba que APP_ORIGINS incluye el dominio de la app.',
      },
      400,
      env,
      request,
    );
  }

  const code = await codeForLink(target);
  const ttl = ttlSeconds(env);
  await env.LINKS.put(`link:${code}`, target, { expirationTtl: ttl });
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  return json(
    {
      code,
      short: `${new URL(request.url).origin}/s/${code}`,
      expiresAt,
      ttlSeconds: ttl,
    },
    201,
    env,
    request,
  );
}

export async function handleRedirect(code: string, env: Env): Promise<Response> {
  if (!CODE_PATTERN.test(code)) return notFound(env);
  const target = await env.LINKS.get(`link:${code}`);
  if (!target) return notFound(env);
  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
      ...corsHeaders(env),
    },
  });
}

function notFound(env: Env): Response {
  const app = allowedOrigins(env)[0];
  const link = app ? `<a href="${app}/">Ir a T-Sim</a>` : '';
  return new Response(
    `<!doctype html><html lang="es"><meta charset="utf-8"><title>Enlace no encontrado</title>` +
      `<body style="font-family:system-ui;background:#313131;color:#e8e8e8;padding:32px">` +
      `<h1>Enlace no encontrado</h1><p>El enlace corto no existe o ha caducado (30 días).</p>${link}</body></html>`,
    {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    },
  );
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env, request) });
  }
  if (request.method === 'POST' && url.pathname === '/api/shorten') {
    return handleShorten(request, env);
  }
  if (request.method === 'GET' && url.pathname.startsWith('/s/')) {
    return handleRedirect(url.pathname.slice(3), env);
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ ok: true, service: 't-sim-link-shortener', ttlSeconds: ttlSeconds(env) }, 200, env, request);
  }
  if (request.method === 'GET' && url.pathname === '/') {
    const app = allowedOrigins(env)[0];
    if (app) {
      return Response.redirect(`${app}/`, 302);
    }
  }
  return notFound(env);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
