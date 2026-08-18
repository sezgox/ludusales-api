# ludusales-api

Backend MVP de `ludusales.com`, hecho con Hono para Cloudflare Workers.

El Worker se despliega como `ludusales-api`.

## Base De Datos

El backend usa Cloudflare D1 con Drizzle ORM para los modelos mínimos de autenticación:

- `companies`: empresas visibles en dashboards.
- `users`: usuarios con rol `company` o `superuser` y hash del código de acceso.

Para preparar la DB local:

```bash
npm run db:reset:local
```

Datos seed locales:

- Superuser: `OWNER-LOCAL-2026`
- Empresa demo: `DEMO-ACCESS-2026`
- Ludus Sales Beta: `BETA-ACCESS-2026`
- Ludus Sales Gamma: `GAMMA-ACCESS-2026`

Los códigos se guardan en DB como `access_code_hash`, no en claro. No guardes usuarios reales ni códigos reales en seeds versionados.

## Endpoints

### `POST /auth/login`

Inicia sesión con un código de acceso guardado en la tabla `users`.

```json
{
  "accessCode": "DEMO-ACCESS-2026"
}
```

Si el código pertenece a un usuario `company`, responde con la empresa asociada y crea la cookie `ls_session` como `HttpOnly`, `SameSite=Lax`, `Path=/` y `Max-Age=28800`. En producción la cookie usa `Secure`.

Si el código pertenece a un usuario `superuser`, crea una sesión con `role: "superuser"` y devuelve el catálogo de empresas de la tabla `companies`.

### `GET /auth/me`

Lee la cookie `ls_session` y devuelve `role: "company"` con la empresa autenticada, o `role: "superuser"` con la lista de empresas visibles.

### `POST /auth/logout`

Borra la cookie `ls_session`.

### `POST /contact`

Envía dos correos con Resend:

- Un correo interno a `CONTACT_TO_EMAIL` con los datos del formulario.
- Un correo de confirmación al email que ha rellenado el usuario.

```json
{
  "firstName": "Juan",
  "lastName": "Pérez",
  "email": "juan@example.com",
  "company": "Acme",
  "teamSize": "12"
}
```

## Desarrollo Local

1. Instala dependencias:

```bash
npm install
```

2. Crea `.dev.vars` usando `.env.example` como base y añade `RESEND_API_KEY` y `JWT_SECRET`.

3. Prepara la DB local:

```bash
npm run db:reset:local
```

4. Arranca el Worker:

```bash
npm run dev
```

El frontend local llama a `http://localhost:8787`.

## Despliegue

Guarda los secretos de Cloudflare:

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put JWT_SECRET
```

Aplica migraciones en la DB remota:

```bash
npx wrangler d1 migrations apply ludusales-db --remote
```

Después despliega manualmente:

```bash
npm run deploy
```

`RESEND_API_KEY` es obligatorio en el Worker desplegado. Si falta, `/contact` responde:

```json
{ "error": "Email service is not configured." }
```

`RESEND_FROM_EMAIL` debe pertenecer a un dominio verificado en Resend para producción.
