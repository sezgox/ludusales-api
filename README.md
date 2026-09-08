# ludusales-api

Backend MVP de `ludusales.com`, hecho con Hono para Cloudflare Workers.

El Worker se despliega como `ludusales-api`.

## Base De Datos

El backend usa Cloudflare D1 con Drizzle ORM para los modelos mínimos de autenticación:

- `companies`: empresas visibles en dashboards.
- `users`: usuarios con rol `company` o `superuser` y hash del código de acceso.
- `gamifications`: configuración, fechas, objetivo exacto, ciclo y resultado.
- `prizes`: premios ordenados asociados a una gamificación.
- `rankings`: puntuaciones por participante externo; la posición se calcula al consultar.
- `media_deletion_queue`: limpieza reintentable de objetos sustituidos o eliminados de R2.

Los importes se reciben y devuelven como strings decimales. D1 guarda enteros escalados usando
`valuePrecision`, evitando errores de coma flotante. Las imágenes no se guardan en D1: se almacenan
como WebP en el bucket R2 `ludusales-images` y D1 conserva únicamente la clave del objeto.

Para preparar la DB local:

```bash
npm run db:reset:local
```

Datos seed locales:

- Superuser: `OWNER-LOCAL-2026`
- Empresa demo: `DEMO-ACCESS-2026`
- Ludus Sales Beta: `BETA-ACCESS-2026` (una gamificación activa y otra finalizada)
- Ludus Sales Gamma: `GAMMA-ACCESS-2026` (una gamificación activa)

Cada ejecución de la seed restaura Beta y Gamma a esos estados para poder comprobar tanto el
dashboard con datos como el estado vacío desde superuser y desde cada cuenta de empresa.

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

## API de gamificaciones

Lecturas autenticadas:

- `GET /companies/:companyPublicId/gamifications`
- `GET /companies/:companyPublicId/gamifications/:gamificationPublicId`

Una cuenta de empresa solo puede consultar su propia empresa. Un `superuser` puede consultar todas.
Todas las operaciones bajo `/superuser` exigen rol `superuser`:

- `POST /superuser/companies/:companyPublicId/gamifications`
- `PATCH|DELETE /superuser/gamifications/:gamificationPublicId`
- `POST /superuser/gamifications/:gamificationPublicId/activate`
- `POST /superuser/gamifications/:gamificationPublicId/close`
- `POST /superuser/gamifications/:gamificationPublicId/prizes`
- `PATCH|DELETE /superuser/prizes/:prizePublicId`
- `PUT|DELETE /superuser/gamifications/:gamificationPublicId/image`
- `PUT|DELETE /superuser/prizes/:prizePublicId/picture`
- `PUT /superuser/gamifications/:gamificationPublicId/ranking` para reemplazo completo.
- `PUT|DELETE /superuser/gamifications/:gamificationPublicId/ranking/:externalParticipantId` para cambios individuales.

Ejemplo de creación:

```json
{
  "description": "Reto comercial de enero",
  "startAt": "2027-01-01T09:00:00+01:00",
  "endAt": "2027-02-01T18:00:00+01:00",
  "goal": "125.50",
  "valuePrecision": 2,
  "goalUnit": "ventas"
}
```

La posición del ranking se calcula con ranking de competición (`1, 1, 3`). Al cerrar una
gamificación, `outcome` pasa a `achieved` si la suma de puntuaciones alcanza el objetivo; en otro
caso pasa a `missed`. El cron `*/5 * * * *` cierra automáticamente las activas vencidas y limpia R2.

Las rutas de imagen reciben el WebP como cuerpo binario con `Content-Type: image/webp`. Límite:
2 MB y 2400 px por dimensión. La conversión debe realizarse en el navegador antes de subir.

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

R2 se simula localmente mediante el binding `MEDIA_BUCKET`; no hace falta crear un bucket remoto
para desarrollar o ejecutar tests.

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

Antes del primer despliegue, crea el bucket R2:

```bash
npx wrangler r2 bucket create ludusales-images
```

En Cloudflare, conecta el bucket al dominio personalizado `assets.ludusales.com`, habilita caché y
mantén `r2.dev` limitado a desarrollo. El bucket solo necesita lectura pública; las escrituras se
hacen desde el Worker mediante `MEDIA_BUCKET`.

Después despliega manualmente:

```bash
npm run deploy
```

`RESEND_API_KEY` es obligatorio en el Worker desplegado. Si falta, `/contact` responde:

```json
{ "error": "Email service is not configured." }
```

`RESEND_FROM_EMAIL` debe pertenecer a un dominio verificado en Resend para producción.
