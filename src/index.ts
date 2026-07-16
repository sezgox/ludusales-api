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

  const emailBodies = [buildContactNotificationEmail(payload.value, c.env), buildContactConfirmationEmail(payload.value, c.env)];
  const responses = await Promise.all(emailBodies.map((emailBody) => sendResendEmail(emailBody, c.env.RESEND_API_KEY)));
  const failedResponse = responses.find((response) => !response.ok);

  if (failedResponse) {
    const message = await failedResponse.text();
    console.error('Resend API error', failedResponse.status, message);
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

const sendResendEmail = (emailBody: ResendEmailBody, apiKey: string): Promise<Response> =>
  fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(emailBody),
  });

const buildContactNotificationEmail = (payload: ContactPayload, env: Env): ResendEmailBody => {
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

const buildContactConfirmationEmail = (payload: ContactPayload, env: Env): ResendEmailBody => {
  const contactEmail = env.CONTACT_TO_EMAIL ?? 'juanma@ludusales.com';
  const fromEmail = env.RESEND_FROM_EMAIL ?? 'Ludus Sales <contact@ludusales.com>';
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
    <p>Hola ${escapeHtml(firstName)},</p>
    <p>Hemos recibido tu solicitud para agendar una llamada con Ludus Sales.</p>
    <p>Revisaremos la informacion y te responderemos pronto.</p>
    <h2>Resumen de tu solicitud</h2>
    <dl>
      <dt>Empresa</dt>
      <dd>${escapeHtml(payload.company)}</dd>
      <dt>Tamano del equipo de ventas</dt>
      <dd>${escapeHtml(payload.teamSize)}</dd>
    </dl>
    <p>Gracias,<br />Ludus Sales</p>
  `;

  return {
    from: fromEmail,
    to: [payload.email],
    reply_to: contactEmail,
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
