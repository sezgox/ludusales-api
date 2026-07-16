# ludusales-api

Backend MVP de `ludusales.com`, hecho con Hono para Cloudflare Workers.

El Worker se despliega como `ludusales-api`.

## Endpoint

`POST /contact`

Envía a Resend los datos del formulario de contacto del frontend.

```json
{
  "firstName": "Juan",
  "lastName": "Pérez",
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

2. Crea `.dev.vars` usando `.env.example` como base y añade `RESEND_API_KEY`.

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

Después despliega manualmente:

```bash
npm run deploy
```

También hay un workflow de GitHub Actions en `.github/workflows/deploy.yml`. Para usarlo, configura estos secretos del repositorio:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

`RESEND_FROM_EMAIL` debe pertenecer a un dominio verificado en Resend para producción.
