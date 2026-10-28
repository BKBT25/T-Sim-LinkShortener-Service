import { describe, expect, it } from 'vitest';
import { allowedOrigins, codeForLink, handle, type Env, type KvNamespace } from '../src/index';

interface StoredEntry {
  value: string;
  expirationTtl?: number;
}

function fakeKv(): KvNamespace & { store: Map<string, StoredEntry> } {
  const store = new Map<string, StoredEntry>();
  return {
    store,
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, { value, expirationTtl: options?.expirationTtl });
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

const APP = 'https://t-sim.tlanextlilabs.com';
const LONG_LINK = `${APP}/#p=z${'AbC123_-XyZ'.repeat(4)}`;

function makeEnv(overrides: Partial<Env> = {}): Env & { LINKS: ReturnType<typeof fakeKv> } {
  const env = {
    LINKS: fakeKv(),
    APP_ORIGINS: APP,
    LINK_TTL_SECONDS: '2592000',
    RATE_LIMIT_PER_MINUTE: '20',
    ...overrides,
  };
  return env as Env & { LINKS: ReturnType<typeof fakeKv> };
}

function shortenRequest(url: unknown, ip = '1.2.3.4', origin = APP): Request {
  return new Request('https://go.t-sim.tlanextlilabs.com/api/shorten', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
      origin,
    },
    body: JSON.stringify({ url }),
  });
}

function redirectRequest(code: string): Request {
  return new Request(`https://go.t-sim.tlanextlilabs.com/s/${code}`);
}

describe('acortador de enlaces de T-Sim', () => {
  it('acorta un enlace autónomo de la app y caduca en 30 días', async () => {
    const env = makeEnv();
    const response = await handle(shortenRequest(LONG_LINK), env);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      code: string;
      short: string;
      expiresAt: string;
      ttlSeconds: number;
    };
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(body.short).toBe(`https://go.t-sim.tlanextlilabs.com/s/${body.code}`);
    expect(body.ttlSeconds).toBe(30 * 24 * 60 * 60);
    const expires = new Date(body.expiresAt).getTime();
    expect(expires - Date.now()).toBeGreaterThan(29.9 * 24 * 3600 * 1000);
    expect(env.LINKS.store.get(`link:${body.code}`)?.expirationTtl).toBe(2592000);
  });

  it('redirige el código al enlace largo', async () => {
    const env = makeEnv();
    const created = (await (await handle(shortenRequest(LONG_LINK), env)).json()) as { code: string };
    const response = await handle(redirectRequest(created.code), env);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(new URL(LONG_LINK).toString());    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('el mismo circuito produce el mismo código', async () => {
    const env = makeEnv();
    const first = (await (await handle(shortenRequest(LONG_LINK), env)).json()) as { code: string };
    const second = (await (await handle(shortenRequest(LONG_LINK, '9.9.9.9'), env)).json()) as {
      code: string;
    };
    expect(second.code).toBe(first.code);
    expect(await codeForLink(new URL(LONG_LINK).toString())).toBe(first.code);
  });

  it('acepta solo el payload `{ payload }` como atajo', async () => {
    const env = makeEnv();
    const response = await handle(
      new Request('https://go.t-sim.tlanextlilabs.com/api/shorten', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '7.7.7.7', origin: APP },
        body: JSON.stringify({ payload: `#p=z${'AbC123_-XyZ'.repeat(4)}` }),
      }),
      env,
    );
    expect(response.status).toBe(201);
  });

  it('rechaza enlaces de otros dominios (open redirect)', async () => {
    const env = makeEnv();
    expect(
      (await handle(shortenRequest('https://evil.example/#p=zAbC123_-XyZ'), env)).status,
    ).toBe(400);
  });

  it('rechaza enlaces sin circuito en el hash', async () => {
    const env = makeEnv();
    expect((await handle(shortenRequest(`${APP}/`), env)).status).toBe(400);
    expect((await handle(shortenRequest(`${APP}/#p=`), env)).status).toBe(400);
    expect((await handle(shortenRequest(`${APP}/#otra-cosa`), env)).status).toBe(400);
    expect((await handle(shortenRequest(`${APP}/#p=xAbC123_-XyZ`), env)).status).toBe(400);
  });

  it('rechaza cuerpos enormes', async () => {
    const env = makeEnv();
    const response = await handle(shortenRequest(`${APP}/#p=z${'A'.repeat(90_000)}`), env);
    expect(response.status).toBe(413);
  });

  it('limita las peticiones por IP', async () => {
    const env = makeEnv({ RATE_LIMIT_PER_MINUTE: '2' });
    expect((await handle(shortenRequest(LONG_LINK), env)).status).toBe(201);
    // La segunda reutiliza el enlace existente, pero también cuenta para el límite.
    expect((await handle(shortenRequest(LONG_LINK), env)).status).toBe(200);
    expect((await handle(shortenRequest(LONG_LINK), env)).status).toBe(429);
    // Otra IP no está limitada y, con otro circuito, crea uno nuevo.
    const otherLink = `${APP}/#p=z${'ZzY9_-QwE'.repeat(4)}`;
    expect((await handle(shortenRequest(otherLink, '5.6.7.8'), env)).status).toBe(201);
  });

  it('un código inexistente o inválido da 404', async () => {
    const env = makeEnv();
    expect((await handle(redirectRequest('NoExiste1'), env)).status).toBe(404);
    expect((await handle(redirectRequest('@@@'), env)).status).toBe(404);
  });

  it('responde al preflight CORS reflejando el origen permitido', async () => {
    const env = makeEnv();
    const response = await handle(
      new Request('https://go.t-sim.tlanextlilabs.com/api/shorten', {
        method: 'OPTIONS',
        headers: { origin: APP },
      }),
      env,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('admite varios orígenes (dominio propio + localhost de desarrollo)', async () => {
    const env = makeEnv({
      APP_ORIGINS: `${APP},http://localhost:5173`,
    });
    expect(allowedOrigins(env)).toEqual([APP, 'http://localhost:5173']);
    const local = 'http://localhost:5173';
    const response = await handle(shortenRequest(`${local}/#p=z${'AbC123_-XyZ'.repeat(4)}`, '8.8.8.8', local), env);
    expect(response.status).toBe(201);
  });

  it('sin APP_ORIGINS configurado responde 500', async () => {
    const env = makeEnv({ APP_ORIGINS: '' });
    expect((await handle(shortenRequest(LONG_LINK), env)).status).toBe(500);
  });

  it('/health responde ok', async () => {
    const env = makeEnv();
    const response = await handle(new Request('https://go.t-sim.tlanextlilabs.com/health'), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; ttlSeconds: number };
    expect(body.ok).toBe(true);
    expect(body.ttlSeconds).toBe(2592000);
  });

  it('la raíz redirige a la app', async () => {
    const env = makeEnv();
    const response = await handle(new Request('https://go.t-sim.tlanextlilabs.com/'), env);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(`${APP}/`);
  });
});

function lookupRequest(url: string, origin = APP): Request {
  const params = new URLSearchParams({ url });
  return new Request(`https://go.t-sim.tlanextlilabs.com/api/shorten?${params.toString()}`, {
    method: 'GET',
    headers: { origin },
  });
}

describe('sin duplicados del mismo circuito', () => {
  it('la consulta previa responde 404 si todavía no existe', async () => {
    const env = makeEnv();
    const response = await handle(lookupRequest(LONG_LINK), env);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { exists: boolean; code: string };
    expect(body.exists).toBe(false);
    expect(body.code).toBe(await codeForLink(new URL(LONG_LINK).toString()));
  });

  it('después de crearlo, la consulta lo encuentra', async () => {
    const env = makeEnv();
    const created = (await (await handle(shortenRequest(LONG_LINK), env)).json()) as {
      code: string;
      expiresAt: string;
    };
    const response = await handle(lookupRequest(LONG_LINK), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      exists: boolean;
      created: boolean;
      code: string;
      short: string;
      expiresAt: string;
    };
    expect(body.exists).toBe(true);
    expect(body.created).toBe(false);
    expect(body.code).toBe(created.code);
    expect(body.short).toBe(`https://go.t-sim.tlanextlilabs.com/s/${created.code}`);
    expect(body.expiresAt).toBe(created.expiresAt);
  });

  it('crear dos veces el mismo contenido reutiliza el enlace y no reescribe KV', async () => {
    const env = makeEnv();
    const first = await handle(shortenRequest(LONG_LINK), env);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { code: string; created: boolean; expiresAt: string };
    expect(firstBody.created).toBe(true);

    const writesAfterFirst = [...env.LINKS.store.keys()].filter((key) => key.startsWith('link:')).length;
    const second = await handle(shortenRequest(LONG_LINK, '3.3.3.3'), env);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { code: string; created: boolean; expiresAt: string };
    expect(secondBody.code).toBe(firstBody.code);
    expect(secondBody.created).toBe(false);
    expect(secondBody.expiresAt).toBe(firstBody.expiresAt);
    // Un solo registro y con la caducidad original (no se reinicia).
    const keys = [...env.LINKS.store.keys()].filter((key) => key.startsWith('link:'));
    expect(keys).toHaveLength(writesAfterFirst);
    expect(env.LINKS.store.get(`link:${firstBody.code}`)?.expirationTtl).toBe(2592000);
  });

  it('la consulta rechaza enlaces ajenos o sin hash', async () => {
    const env = makeEnv();
    expect((await handle(lookupRequest('https://evil.example/#p=zAbC123_-XyZ'), env)).status).toBe(400);
    expect((await handle(lookupRequest(`${APP}/`), env)).status).toBe(400);
  });

  it('sigue leyendo enlaces guardados con el formato antiguo (URL en texto)', async () => {
    const env = makeEnv();
    const code = await codeForLink(new URL(LONG_LINK).toString());
    env.LINKS.store.set(`link:${code}`, { value: new URL(LONG_LINK).toString() });
    const response = await handle(redirectRequest(code), env);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(new URL(LONG_LINK).toString());
    const lookup = await handle(lookupRequest(LONG_LINK), env);
    expect(lookup.status).toBe(200);
    const body = (await lookup.json()) as { exists: boolean; expiresAt: string };
    expect(body.exists).toBe(true);
    expect(body.expiresAt).toBe('');
  });
});
