import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import { companies, users } from './db/schema';

type ContactPayload = {
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  teamSize: string;
};

type ResendEmailBody = {
  from: string;
  to: string[];
  reply_to: string;
  subject: string;
  text: string;
  html: string;
};

type Company = {
  id: number;
  public_id: string;
  name: string;
};

type DashboardCompany = Pick<Company, 'public_id' | 'name'>;
type AuthenticatedCompany = DashboardCompany;
type UserRole = 'company' | 'superuser';

type LoginPayload = {
  accessCode: string;
};

type CreateCompanyAccountPayload = {
  companyName: string;
  accountName: string;
  email: string | null;
  accessCode: string;
};

type JwtPayload = {
  sub: string;
  role: UserRole;
  iat: number;
  exp: number;
  jti: string;
};

type AuthenticatedPrincipal =
  | {
      role: 'company';
      user_public_id: string;
      company: AuthenticatedCompany;
    }
  | {
      role: 'superuser';
      user_public_id: string;
      companies: DashboardCompany[];
    };

type D1DatabaseBinding = Parameters<typeof drizzle>[0];
type AppContext = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

const defaultAllowedOrigins = ['https://ludusales.com', 'https://www.ludusales.com', 'http://localhost:4200'];
const defaultContactEmail = 'juan.mateo@ludusales.com';
const sessionCookieName = 'ls_session';
const sessionMaxAgeSeconds = 60 * 60 * 8;
const jwtHeader = { alg: 'HS256', typ: 'JWT' };

app.use(
  '*',
  cors({
    origin: (origin, c) => {
      if (!origin) {
        return null;
      }

      const configuredOrigins = c.env.FRONTEND_ORIGINS?.split(',')
        .map((item: string) => item.trim())
        .filter(Boolean);
      const allowedOrigins = configuredOrigins?.length ? configuredOrigins : defaultAllowedOrigins;

      return allowedOrigins.includes(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    credentials: true,
    maxAge: 86400,
  }),
);

app.get('/health', (c) => c.json({ ok: true }));

app.post('/auth/login', async (c) => {
  const payload = await readLoginPayload(c.req.raw);

  if (!payload.ok) {
    return c.json({ error: payload.error }, 400);
  }

  if (!c.env.JWT_SECRET) {
    return c.json({ error: 'Authentication service is not configured.' }, 500);
  }

  let principal: AuthenticatedPrincipal | null;

  try {
    principal = await authenticatePrincipal(c.env, payload.value.accessCode);
  } catch (error) {
    console.error('Authentication configuration error', error);
    return c.json({ error: 'Authentication service is not configured.' }, 500);
  }

  if (!principal) {
    return c.json({ error: 'Invalid access code.' }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    {
      sub: principal.user_public_id,
      role: principal.role,
      iat: now,
      exp: now + sessionMaxAgeSeconds,
      jti: crypto.randomUUID(),
    },
    c.env.JWT_SECRET,
  );

  setSessionCookie(c, token);

  return c.json({ ok: true, ...toAuthResponse(principal) });
});

app.get('/auth/me', async (c) => {
  const token = getCookie(c, sessionCookieName);

  if (!c.env.JWT_SECRET) {
    return c.json({ error: 'Authentication service is not configured.' }, 500);
  }

  if (!token) {
    return c.json({ error: 'Not authenticated.' }, 401);
  }

  const payload = await verifyJwt(token, c.env.JWT_SECRET);

  if (!payload) {
    return c.json({ error: 'Not authenticated.' }, 401);
  }

  let principal: AuthenticatedPrincipal | null;

  try {
    principal = await readPrincipal(c.env, payload);
  } catch (error) {
    console.error('Authentication configuration error', error);
    return c.json({ error: 'Authentication service is not configured.' }, 500);
  }

  return principal ? c.json({ ok: true, ...toAuthResponse(principal) }) : c.json({ error: 'Not authenticated.' }, 401);
});

app.post('/auth/logout', (c) => {
  deleteSessionCookie(c);

  return c.json({ ok: true });
});

app.post('/superuser/companies', async (c) => {
  const payload = await readCreateCompanyAccountPayload(c.req.raw);

  if (!payload.ok) {
    return c.json({ error: payload.error }, 400);
  }

  const auth = await readAuthenticatedPrincipal(c);

  if (!auth.ok) {
    return auth.response;
  }

  if (auth.principal.role !== 'superuser') {
    return c.json({ error: 'Forbidden.' }, 403);
  }

  const db = createDb(c.env);

  if (!db) {
    return c.json({ error: 'Authentication service is not configured.' }, 500);
  }

  try {
    const company = await createCompanyAccountInDb(db, payload.value);

    return c.json({ ok: true, company });
  } catch (error) {
    console.error('Company creation error', error);
    return c.json({ error: 'Unable to create company.' }, isUniqueConstraintError(error) ? 409 : 500);
  }
});

app.post('/contact', async (c) => {
  const payload = await readContactPayload(c.req.raw);

  if (!payload.ok) {
    return c.json({ error: payload.error }, 400);
  }

  if (!c.env.RESEND_API_KEY) {
    return c.json({ error: 'Email service is not configured.' }, 500);
  }

  const emailBodies = [buildContactNotificationEmail(payload.value, c.env), buildContactConfirmationEmail(payload.value, c.env)];
  const responses = await Promise.all(emailBodies.map((emailBody) => sendContactEmail(emailBody, c.env.RESEND_API_KEY)));
  const failedResponse = responses.find((response) => !response.ok);

  if (failedResponse) {
    const message = await failedResponse.text();
    console.error('Resend API error', failedResponse.status, message);
    return c.json({ error: 'Unable to send contact email.' }, 502);
  }

  return c.json({ ok: true });
});

const readLoginPayload = async (
  request: Request,
): Promise<{ ok: true; value: LoginPayload } | { ok: false; error: string }> => {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return { ok: false, error: 'Invalid JSON body.' };
  }

  if (!isRecord(body)) {
    return { ok: false, error: 'Invalid login payload.' };
  }

  const accessCode = readRequiredString(body, 'accessCode', 80);

  if (!accessCode) {
    return { ok: false, error: 'Invalid login payload.' };
  }

  return { ok: true, value: { accessCode } };
};

const readCreateCompanyAccountPayload = async (
  request: Request,
): Promise<{ ok: true; value: CreateCompanyAccountPayload } | { ok: false; error: string }> => {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return { ok: false, error: 'Invalid JSON body.' };
  }

  const parsed = parseCreateCompanyAccountPayload(body);

  if (!parsed) {
    return { ok: false, error: 'Invalid company payload.' };
  }

  return { ok: true, value: parsed };
};

const readContactPayload = async (
  request: Request,
): Promise<{ ok: true; value: ContactPayload } | { ok: false; error: string }> => {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return { ok: false, error: 'Invalid JSON body.' };
  }

  const parsed = parseContactPayload(body);

  if (!parsed) {
    return { ok: false, error: 'Invalid contact payload.' };
  }

  return { ok: true, value: parsed };
};

const parseCreateCompanyAccountPayload = (body: unknown): CreateCompanyAccountPayload | null => {
  if (!isRecord(body)) {
    return null;
  }

  const companyName = readRequiredString(body, 'companyName', 160);
  const accountName = readRequiredString(body, 'accountName', 160);
  const accessCode = readRequiredString(body, 'accessCode', 80);
  const emailValue = body['email'];
  const email = typeof emailValue === 'string' ? emailValue.trim() : null;

  if (!companyName || !accountName || !accessCode || accessCode.length < 8) {
    return null;
  }

  if (email && (email.length > 254 || !isEmail(email))) {
    return null;
  }

  return {
    companyName,
    accountName,
    email: email || null,
    accessCode,
  };
};

const parseContactPayload = (body: unknown): ContactPayload | null => {
  if (!isRecord(body)) {
    return null;
  }

  const firstName = readRequiredString(body, 'firstName', 80);
  const lastName = readRequiredString(body, 'lastName', 120);
  const email = readRequiredString(body, 'email', 254);
  const company = readRequiredString(body, 'company', 160);
  const teamSize = readRequiredString(body, 'teamSize', 80);

  if (!firstName || !lastName || !email || !company || !teamSize || !isEmail(email)) {
    return null;
  }

  return { firstName, lastName, email, company, teamSize };
};

const createDb = (env: Env): DrizzleD1Database<typeof schema> | null => {
  const d1Database: unknown = Reflect.get(env, 'DB');

  return isD1Database(d1Database) ? drizzle(d1Database, { schema }) : null;
};

const isD1Database = (value: unknown): value is D1DatabaseBinding =>
  isRecord(value) && typeof value['prepare'] === 'function';

const authenticatePrincipal = async (env: Env, accessCode: string): Promise<AuthenticatedPrincipal | null> => {
  const db = createDb(env);

  if (!db) {
    throw new Error('Missing D1 DB binding.');
  }

  return authenticatePrincipalFromDb(db, accessCode);
};

const authenticatePrincipalFromDb = async (
  db: DrizzleD1Database<typeof schema>,
  accessCode: string,
): Promise<AuthenticatedPrincipal | null> => {
  const accessCodeHash = await hashAccessCode(accessCode);
  const user = await db
    .select()
    .from(users)
    .where(and(eq(users.accessCodeHash, accessCodeHash), eq(users.isActive, true)))
    .limit(1)
    .get();

  return user ? principalFromDbUser(db, user) : null;
};

const readPrincipal = async (env: Env, payload: JwtPayload): Promise<AuthenticatedPrincipal | null> => {
  const db = createDb(env);

  if (!db) {
    throw new Error('Missing D1 DB binding.');
  }

  return readPrincipalFromDb(db, payload);
};

const readAuthenticatedPrincipal = async (
  c: AppContext,
): Promise<{ ok: true; principal: AuthenticatedPrincipal } | { ok: false; response: Response }> => {
  const token = getCookie(c, sessionCookieName);

  if (!c.env.JWT_SECRET) {
    return { ok: false, response: c.json({ error: 'Authentication service is not configured.' }, 500) };
  }

  if (!token) {
    return { ok: false, response: c.json({ error: 'Not authenticated.' }, 401) };
  }

  const payload = await verifyJwt(token, c.env.JWT_SECRET);

  if (!payload) {
    return { ok: false, response: c.json({ error: 'Not authenticated.' }, 401) };
  }

  try {
    const principal = await readPrincipal(c.env, payload);

    return principal
      ? { ok: true, principal }
      : { ok: false, response: c.json({ error: 'Not authenticated.' }, 401) };
  } catch (error) {
    console.error('Authentication configuration error', error);
    return { ok: false, response: c.json({ error: 'Authentication service is not configured.' }, 500) };
  }
};

const readPrincipalFromDb = async (
  db: DrizzleD1Database<typeof schema>,
  payload: JwtPayload,
): Promise<AuthenticatedPrincipal | null> => {
  const user = await db
    .select()
    .from(users)
    .where(and(eq(users.publicId, payload.sub), eq(users.role, payload.role), eq(users.isActive, true)))
    .limit(1)
    .get();

  return user ? principalFromDbUser(db, user) : null;
};

const principalFromDbUser = async (
  db: DrizzleD1Database<typeof schema>,
  user: typeof users.$inferSelect,
): Promise<AuthenticatedPrincipal | null> => {
  if (user.role === 'superuser') {
    return {
      role: 'superuser',
      user_public_id: user.publicId,
      companies: await readDashboardCompaniesFromDb(db),
    };
  }

  if (user.companyId === null) {
    return null;
  }

  const company = await db.select().from(companies).where(eq(companies.id, user.companyId)).limit(1).get();

  if (!company) {
    return null;
  }

  return {
    role: 'company',
    user_public_id: user.publicId,
    company: toAuthenticatedCompany({
      id: company.id,
      public_id: company.publicId,
      name: company.name,
    }),
  };
};

const readDashboardCompaniesFromDb = async (
  db: DrizzleD1Database<typeof schema>,
): Promise<DashboardCompany[]> => {
  const rows = await db
    .select({
      public_id: companies.publicId,
      name: companies.name,
    })
    .from(companies)
    .orderBy(asc(companies.name))
    .all();

  return rows;
};

const createCompanyAccountInDb = async (
  db: DrizzleD1Database<typeof schema>,
  payload: CreateCompanyAccountPayload,
): Promise<DashboardCompany> => {
  const companyPublicId = crypto.randomUUID();
  const userPublicId = crypto.randomUUID();
  const accessCodeHash = await hashAccessCode(payload.accessCode);
  const company = await db
    .insert(companies)
    .values({
      publicId: companyPublicId,
      name: payload.companyName,
    })
    .returning({
      id: companies.id,
      public_id: companies.publicId,
      name: companies.name,
    })
    .get();

  try {
    await db
      .insert(users)
      .values({
        publicId: userPublicId,
        role: 'company',
        displayName: payload.accountName,
        email: payload.email,
        accessCodeHash,
        companyId: company.id,
      })
      .run();
  } catch (error) {
    await db.delete(companies).where(eq(companies.id, company.id)).run();
    throw error;
  }

  return {
    public_id: company.public_id,
    name: company.name,
  };
};

const toAuthResponse = (
  principal: AuthenticatedPrincipal,
): { role: 'company'; company: AuthenticatedCompany } | { role: 'superuser'; companies: DashboardCompany[] } => {
  if (principal.role === 'company') {
    return {
      role: 'company',
      company: principal.company,
    };
  }

  return {
    role: 'superuser',
    companies: principal.companies,
  };
};

const toAuthenticatedCompany = (company: Company): AuthenticatedCompany => ({
  public_id: company.public_id,
  name: company.name,
});

const canAccessCompany = (principal: AuthenticatedPrincipal, companyPublicId: string): boolean => {
  if (principal.role === 'company') {
    return principal.company.public_id === companyPublicId;
  }

  return principal.companies.some((company) => company.public_id === companyPublicId);
};

const setSessionCookie = (c: Parameters<typeof setCookie>[0], token: string): void => {
  setCookie(c, sessionCookieName, token, {
    httpOnly: true,
    maxAge: sessionMaxAgeSeconds,
    path: '/',
    sameSite: 'Lax',
    secure: shouldUseSecureCookie(c.req.raw),
  });
};

const deleteSessionCookie = (c: Parameters<typeof deleteCookie>[0]): void => {
  deleteCookie(c, sessionCookieName, {
    path: '/',
    sameSite: 'Lax',
    secure: shouldUseSecureCookie(c.req.raw),
  });
};

const shouldUseSecureCookie = (request: Request): boolean => {
  const url = new URL(request.url);

  return url.hostname !== 'localhost' && url.hostname !== '127.0.0.1';
};

const signJwt = async (payload: JwtPayload, secret: string): Promise<string> => {
  const header = encodeBase64Url(JSON.stringify(jwtHeader));
  const body = encodeBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256(`${header}.${body}`, secret);

  return `${header}.${body}.${signature}`;
};

const verifyJwt = async (token: string, secret: string): Promise<JwtPayload | null> => {
  const parts = token.split('.');

  if (parts.length !== 3) {
    return null;
  }

  const [header, body, signature] = parts;
  const expectedSignature = await hmacSha256(`${header}.${body}`, secret);

  if (!timingSafeStringEqual(signature, expectedSignature)) {
    return null;
  }

  const parsed = parseJwtPayload(body);
  const now = Math.floor(Date.now() / 1000);

  if (!parsed || parsed.exp <= now) {
    return null;
  }

  return parsed;
};

const parseJwtPayload = (encodedPayload: string): JwtPayload | null => {
  let body: unknown;

  try {
    body = JSON.parse(decodeBase64Url(encodedPayload));
  } catch {
    return null;
  }

  if (!isRecord(body)) {
    return null;
  }

  const sub = body['sub'];
  const role = body['role'] ?? 'company';
  const iat = body['iat'];
  const exp = body['exp'];
  const jti = body['jti'];

  if (
    typeof sub !== 'string' ||
    (role !== 'company' && role !== 'superuser') ||
    typeof iat !== 'number' ||
    typeof exp !== 'number' ||
    typeof jti !== 'string'
  ) {
    return null;
  }

  return {
    sub,
    role,
    iat,
    exp,
    jti,
  };
};

const hmacSha256 = async (value: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));

  return encodeBase64Url(new Uint8Array(signature));
};

const hashAccessCode = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));

  return encodeBase64Url(new Uint8Array(digest));
};

const encodeBase64Url = (value: string | Uint8Array): string => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const binary = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join('');

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const decodeBase64Url = (value: string): string => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);

  return new TextDecoder().decode(bytes);
};

const timingSafeStringEqual = (left: string, right: string): boolean => {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
};

const sendContactEmail = (emailBody: ResendEmailBody, apiKey: string): Promise<Response> =>
  fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(emailBody),
  });

const buildContactNotificationEmail = (payload: ContactPayload, env: Env): ResendEmailBody => {
  const toEmail = env.CONTACT_TO_EMAIL ?? defaultContactEmail;
  const fromEmail = env.RESEND_FROM_EMAIL ?? `Ludus Sales <${defaultContactEmail}>`;
  const subject = `Nueva solicitud de llamada - ${payload.company}`;
  const text = [
    'Nueva solicitud de llamada desde ludusales.com',
    '',
    `Nombre: ${payload.firstName} ${payload.lastName}`,
    `Email: ${payload.email}`,
    `Empresa: ${payload.company}`,
    `Tamano del equipo de ventas: ${payload.teamSize}`,
  ].join('\n');
  const html = `
${buildEmailShell({
  preview: `Nueva solicitud de ${payload.firstName} ${payload.lastName} desde ludusales.com`,
  eyebrow: 'Nueva solicitud',
  title: `${payload.firstName} ${payload.lastName} quiere hablar con Ludus Sales`,
  lead: 'Han completado el formulario de contacto. Responde directamente a este correo para continuar la conversacion.',
  content: `
    ${buildEmailDetailTable([
      ['Nombre', `${payload.firstName} ${payload.lastName}`],
      ['Email', payload.email],
      ['Empresa', payload.company],
      ['Tamano del equipo de ventas', payload.teamSize],
    ])}
    ${buildEmailButton('Responder al lead', buildMailtoHref(payload.email, `Re: ${subject}`))}
  `,
})}`;

  return {
    from: fromEmail,
    to: [toEmail],
    reply_to: payload.email,
    subject,
    text,
    html,
  };
};

const buildContactConfirmationEmail = (payload: ContactPayload, env: Env): ResendEmailBody => {
  const contactEmail = env.CONTACT_TO_EMAIL ?? defaultContactEmail;
  const fromEmail = env.RESEND_FROM_EMAIL ?? `Ludus Sales <${defaultContactEmail}>`;
  const firstName = payload.firstName;
  const subject = 'Hemos recibido tu solicitud en Ludus Sales';
  const text = [
    `Hola ${firstName},`,
    '',
    'Hemos recibido tu solicitud para agendar una llamada con Ludus Sales.',
    'Revisaremos la informacion y te responderemos pronto.',
    '',
    'Resumen de tu solicitud:',
    `Empresa: ${payload.company}`,
    `Tamano del equipo de ventas: ${payload.teamSize}`,
    '',
    'Gracias,',
    'Ludus Sales',
  ].join('\n');
  const html = `
${buildEmailShell({
  preview: 'Hemos recibido tu solicitud para agendar una llamada con Ludus Sales.',
  eyebrow: 'Solicitud recibida',
  title: `Hola ${firstName}, ya tenemos tu solicitud`,
  lead: 'Gracias por contactar con Ludus Sales. Revisaremos la informacion y te responderemos pronto para coordinar los siguientes pasos.',
  content: `
    ${buildEmailDetailTable([
      ['Empresa', payload.company],
      ['Tamano del equipo de ventas', payload.teamSize],
    ])}
    <p style="margin:24px 0 0;color:#4a5565;font-size:15px;line-height:1.6;">
      Mientras tanto, puedes responder a este mismo correo si quieres anadir algun detalle antes de la llamada.
    </p>
  `,
})}`;

  return {
    from: fromEmail,
    to: [payload.email],
    reply_to: contactEmail,
    subject,
    text,
    html,
  };
};

const buildEmailShell = ({
  preview,
  eyebrow,
  title,
  lead,
  content,
}: {
  preview: string;
  eyebrow: string;
  title: string;
  lead: string;
  content: string;
}): string => `
  <div style="display:none;max-height:0;overflow:hidden;color:transparent;opacity:0;">
    ${escapeHtml(preview)}
  </div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0;padding:0;background-color:#f6f8f4;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background-color:#ffffff;border:1px solid #dce4d8;border-radius:8px;overflow:hidden;font-family:Inter,Segoe UI,Arial,sans-serif;">
          <tr>
            <td style="padding:28px 32px;background-color:#1e5125;background-image:linear-gradient(135deg,#1e5125 0%,#278537 100%);">
              <p style="margin:0 0 10px;color:#ffb900;font-size:12px;font-weight:800;letter-spacing:0;text-transform:uppercase;">
                ${escapeHtml(eyebrow)}
              </p>
              <h1 style="margin:0;color:#ffffff;font-size:28px;line-height:1.16;font-weight:800;">
                ${escapeHtml(title)}
              </h1>
              <p style="margin:16px 0 0;color:#e8f4e3;font-size:16px;line-height:1.6;">
                ${escapeHtml(lead)}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:30px 32px;">
              ${content}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px;background-color:#edf2ea;border-top:1px solid #dce4d8;">
              <p style="margin:0;color:#657467;font-size:13px;line-height:1.5;">
                Ludus Sales - Automatizacion comercial para equipos que venden mejor.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
`;

const buildEmailDetailTable = (rows: [string, string][]): string => `
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #dce4d8;border-radius:8px;overflow:hidden;">
    ${rows
      .map(
        ([label, value]) => `
          <tr>
            <td style="width:38%;padding:14px 16px;background-color:#f8faf6;border-bottom:1px solid #e6ece2;color:#1e5125;font-size:13px;font-weight:800;text-transform:uppercase;">
              ${escapeHtml(label)}
            </td>
            <td style="padding:14px 16px;border-bottom:1px solid #e6ece2;color:#142018;font-size:15px;font-weight:700;">
              ${escapeHtml(value)}
            </td>
          </tr>
        `,
      )
      .join('')}
  </table>
`;

const buildEmailButton = (label: string, href: string): string => `
  <table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:24px;">
    <tr>
      <td style="border-radius:8px;background-color:#ffb900;">
        <a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 18px;color:#1e5125;font-size:15px;font-weight:800;text-decoration:none;">
          ${escapeHtml(label)}
        </a>
      </td>
    </tr>
  </table>
`;

const buildMailtoHref = (email: string, subject: string): string => `mailto:${email}?subject=${encodeURIComponent(subject)}`;

const readRequiredString = (record: Record<string, unknown>, key: string, maxLength: number): string | null => {
  const value = record[key];

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed || trimmed.length > maxLength) {
    return null;
  }

  return trimmed;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Error && error.message.toLocaleLowerCase('en-US').includes('unique');

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export default app;
