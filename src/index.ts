import { Hono } from 'hono';
import { cors } from 'hono/cors';

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

const app = new Hono<{ Bindings: Env }>();

const defaultAllowedOrigins = ['https://ludusales.com', 'https://www.ludusales.com', 'http://localhost:4200'];

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
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 86400,
  }),
);

app.get('/health', (c) => c.json({ ok: true }));

app.post('/contact', async (c) => {
  const payload = await readContactPayload(c.req.raw);

  if (!payload.ok) {
    return c.json({ error: payload.error }, 400);
  }

  if (!c.env.RESEND_API_KEY) {
    return c.json({ error: 'Email service is not configured.' }, 500);
  }

  const emailBody = buildEmailBody(payload.value, c.env);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(emailBody),
  });

  if (!response.ok) {
    const message = await response.text();
    console.error('Resend API error', response.status, message);
    return c.json({ error: 'Unable to send contact email.' }, 502);
  }

  return c.json({ ok: true });
});

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

const buildEmailBody = (payload: ContactPayload, env: Env): ResendEmailBody => {
  const toEmail = env.CONTACT_TO_EMAIL ?? 'juanma@ludusales.com';
  const fromEmail = env.RESEND_FROM_EMAIL ?? 'Ludus Sales <contact@ludusales.com>';
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
    <h1>Nueva solicitud de llamada</h1>
    <p>Han completado el formulario de contacto en ludusales.com.</p>
    <dl>
      <dt>Nombre</dt>
      <dd>${escapeHtml(`${payload.firstName} ${payload.lastName}`)}</dd>
      <dt>Email</dt>
      <dd>${escapeHtml(payload.email)}</dd>
      <dt>Empresa</dt>
      <dd>${escapeHtml(payload.company)}</dd>
      <dt>Tamano del equipo de ventas</dt>
      <dd>${escapeHtml(payload.teamSize)}</dd>
    </dl>
  `;

  return {
    from: fromEmail,
    to: [toEmail],
    reply_to: payload.email,
    subject,
    text,
    html,
  };
};

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

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export default app;
