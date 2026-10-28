# T-Sim · Servicio de enlaces cortos

Worker de **Cloudflare** que acorta los enlaces autónomos de
[T-Sim](https://github.com/BKBT25/T-Sim) (`…/#p=…`) y los redirige.

- Dominio previsto: **`https://go.t-sim.tlanextlilabs.com`**
- El circuito sigue viajando dentro del enlace; este servicio **solo guarda
  «código → enlace»** en KV.
- Caducidad del enlace corto: **30 días**.

## Rutas

| Ruta | Respuesta |
|---|---|
| `POST /api/shorten` `{ url }` | `201 { code, short, expiresAt, ttlSeconds }` |
| `GET /s/:code` | `302` al enlace largo (`no-store`, `no-referrer`, `noindex`) |
| `GET /health` | `200 { ok: true, service, ttlSeconds }` |
| `GET /` | `302` a la app |

`POST /api/shorten` acepta también `{ payload: "#p=…" }` como atajo.

## Puesta en marcha

Requisitos: Node 20+ y una cuenta de Cloudflare con la zona
`tlanextlilabs.com` (el dominio personalizado debe estar en la misma cuenta).

```bash
npm install
npx wrangler login

# 1) Crea el espacio de nombres KV y copia el id en wrangler.toml
npx wrangler kv namespace create LINKS

# 2) Despliega (crea también el DNS de go.t-sim.tlanextlilabs.com)
npm run deploy
```

Tras el despliegue comprueba:

```bash
curl https://go.t-sim.tlanextlilabs.com/health
```

### Variables (`wrangler.toml`)

| Variable | Por defecto | Uso |
|---|---|---|
| `APP_ORIGINS` | `https://t-sim.tlanextlilabs.com,http://localhost:5173,http://127.0.0.1:5173` | Orígenes de la app permitidos (separados por comas). **Solo se acortan enlaces de estos orígenes** |
| `LINK_TTL_SECONDS` | `2592000` | Vida del enlace corto (30 días) |
| `RATE_LIMIT_PER_MINUTE` | `20` | Creaciones por minuto y por IP |

Para probar en local con la app delante:

```bash
npm run dev          # http://localhost:8787 (o el puerto que indique)
```

Y en T-Sim, apunta el cliente al Worker local o al de producción:

```bash
VITE_SHORTENER_URL="https://go.t-sim.tlanextlilabs.com" npm run build
```

## Seguridad

- **Sin redirección abierta**: solo acepta URLs cuyo `origin` esté en
  `APP_ORIGINS` y cuyo hash empiece por `#p=` con caracteres válidos.
- **Códigos deterministas**: `sha256(url)` recortado a 10 caracteres en
  base64url (mismo circuito → mismo enlace; sin colisiones prácticas).
- **Límites**: cuerpo máximo 64 kB, 20 creaciones/minuto por IP
  (`cf-connecting-ip`), `cache-control: no-store`, `referrer-policy: no-referrer`.
- **Privacidad**: el enlace (que contiene el circuito) se guarda en KV hasta 30
  días. No se guardan autores, nombres ni datos personales.
- Las respuestas CORS solo permiten los orígenes configurados (`Vary: Origin`).

## Pruebas y tipos

```bash
npm run typecheck
npm test
```

Las pruebas usan un KV en memoria: no necesitan red ni credenciales.

## Coste

Free tier de Workers + KV: 100 000 peticiones/día y 1 000 escrituras KV/día
(suficiente para un aula; el plan pago son ~US$5/mes). 1 GB de KV ≈ millones de
enlaces.

## Licencia

Código propietario de Tlanextli Labs. Todos los derechos reservados.
