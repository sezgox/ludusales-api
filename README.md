# ludusales-api

Backend MVP de `ludusales.com`, hecho con Hono para Cloudflare Workers.

El Worker se despliega como `ludusales-api`.

## Endpoint

`POST /contact`

Envia dos correos con Resend:

- Un correo interno a `CONTACT_TO_EMAIL` con los datos del formulario.
- Un correo de confirmacion al email que ha rellenado el usuario.

```json
{
  "firstName": "Juan",
  "lastName": "Perez",
  "email": "juan@example.com",
  "company": "Acme",
  "teamSize": "12"
}
```

## Desarrollo local

1. Instala dependencias:

```bash
npm install
```

2. Crea `.dev.vars` usando `.env.example` como base y anade `RESEND_API_KEY`.

3. Arranca el Worker:

```bash
npm run dev
```

El frontend local llama a `http://localhost:8787/contact`.

## Despliegue

Guarda la API key como secreto de Cloudflare:

```bash
npx wrangler secret put RESEND_API_KEY
```

Despues despliega manualmente:

```bash
npm run deploy
```

`RESEND_API_KEY` es obligatorio en el Worker desplegado. Si falta, `/contact` responde:

```json
{ "error": "Email service is not configured." }
```

`RESEND_FROM_EMAIL` debe pertenecer a un dominio verificado en Resend para produccion.

## Backoffice

El backoffice vive en el frontend en `/backoffice` y usa este Worker para autenticacion y correo.

### Endpoints

- `GET /auth/microsoft/start`: inicia login OAuth con Microsoft.
- `GET /auth/microsoft/callback`: callback OAuth, crea sesion owner si la cuenta es `OWNER_MICROSOFT_EMAIL`.
- `GET /auth/me`: devuelve sesion actual.
- `POST /auth/logout`: invalida la sesion.
- `GET /backoffice/messages`: lista correos de Inbox con evidencia de destino `OWNER_PUBLIC_EMAIL`.
- `GET /backoffice/messages/:messageKey`: lee un correo permitido.
- `POST /backoffice/messages/:messageKey/reply`: responde con Resend manteniendo `In-Reply-To` y `References`.
- `GET /backoffice/messages/diagnostics/headers`: diagnostico temporal de headers redaccionados.

### D1

Crea la base de datos y sustituye `database_id` en `wrangler.jsonc`:

```bash
npx wrangler d1 create ludusales-backoffice
npx wrangler d1 migrations apply ludusales-backoffice --local
npx wrangler d1 migrations apply ludusales-backoffice --remote
```

El Worker tambien ejecuta `CREATE TABLE IF NOT EXISTS` al usar rutas protegidas para facilitar desarrollo local.

### Secrets

Configura estos secretos en Cloudflare:

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MICROSOFT_CLIENT_ID
npx wrangler secret put MICROSOFT_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

Para local, anade esos valores a `.dev.vars` usando `.env.example` como referencia.

### Microsoft OAuth

Registra una app en Microsoft identity platform con cuentas personales habilitadas y estos permisos delegados:

- `openid`
- `profile`
- `email`
- `offline_access`
- `User.Read`
- `Mail.Read`

Redirects:

- Local: `http://localhost:8787/auth/microsoft/callback`
- Produccion: `https://api.ludusales.com/auth/microsoft/callback`

La cuenta permitida es `OWNER_MICROSOFT_EMAIL` y por defecto es `juan.mateoc@outlook.com`.

### Limitacion importante

Como `juanma@ludusales.com` redirige desde Cloudflare Email Routing a `juan.mateoc@outlook.com`, el Worker solo muestra correos cuando Graph conserva evidencia clara del destinatario corporativo en recipients o headers. Los correos dudosos se ocultan para no mezclar correo directo de Outlook.
