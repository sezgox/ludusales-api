# ludusales-api

Backend MVP de `ludusales.com`, hecho con Hono para Cloudflare Workers.

El Worker se despliega como `ludusales-api`.

## Endpoints

### `POST /auth/login`

Inicia sesion de empresa con un codigo de acceso. Mientras no exista Supabase, valida contra variables placeholder del entorno.

```json
{
  "accessCode": "DEMO-ACCESS-2026"
}
```

Si el codigo es valido, responde con la empresa y crea la cookie `ls_session` como `HttpOnly`, `SameSite=Lax`, `Path=/` y `Max-Age=28800`. En produccion la cookie usa `Secure`.

### `GET /auth/me`

Lee la cookie `ls_session` y devuelve la empresa autenticada.

### `POST /auth/logout`

Borra la cookie `ls_session`.

### `POST /contact`

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

2. Crea `.dev.vars` usando `.env.example` como base y anade `RESEND_API_KEY`, `JWT_SECRET` y `PLACEHOLDER_COMPANY_ACCESS_CODE`.

3. Arranca el Worker:

```bash
npm run dev
```

El frontend local llama a `http://localhost:8787/contact`.

## Despliegue

Guarda la API key como secreto de Cloudflare:

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put JWT_SECRET
npx wrangler secret put PLACEHOLDER_COMPANY_ACCESS_CODE
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
