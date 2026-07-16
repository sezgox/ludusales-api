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

Tambien hay un workflow de GitHub Actions en `.github/workflows/deploy.yml`. Para usarlo, configura estos secretos del repositorio:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

`RESEND_API_KEY` es obligatorio en el Worker desplegado. Si falta, `/contact` responde:

```json
{ "error": "Email service is not configured." }
```

`RESEND_FROM_EMAIL` debe pertenecer a un dominio verificado en Resend para produccion.
