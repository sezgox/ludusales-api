import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  ensureSchema,
  findCachedMessage,
  findOutboundRepliesForThread,
  findSessionUser,
  findUserByMicrosoftEmail,
  insertOutboundReply,
  insertSession,
  deleteSession,
  upsertOAuthTokens,
  upsertOwnerUser,
  UserRecord,
} from './db';
import {
  buildMessageDetail,
  buildMessageDetailWithThread,
  buildMessageSummary,
  buildReplyEmail,
  cacheMessage,
  findCorporateRecipientEvidence,
  redactHeaders,
  sendResendEmail,
} from './mail';
import {
  exchangeAuthorizationCode,
  fetchConversationMessages,
  fetchInboxMessages,
  fetchMessage,
  fetchMicrosoftMe,
  getMicrosoftAccessToken,
  microsoftAuthorizeUrl,
} from './microsoft';
import { decodeKey, encryptSecret, randomToken, sha256Hex } from './security';

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

type AppVariables = {
  user: UserRecord;
};

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const defaultAllowedOrigins = ['https://ludusales.com', 'https://www.ludusales.com', 'http://localhost:4200'];
const sessionCookieName = 'ludus_session';
const authStateCookieName = 'ludus_ms_state';
const sessionMaxAgeSeconds = 60 * 60 * 24 * 7;

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

app.get('/auth/microsoft/start', async (c) => {
  const configurationError = validateAuthConfiguration(c.env);

  if (configurationError) {
    return c.json({ error: configurationError }, 500);
  }

  const state = randomToken(24);
  setCookie(c, authStateCookieName, state, buildCookieOptions(c.req.raw, 600));

  return c.redirect(microsoftAuthorizeUrl(c.env, state));
});

app.get('/auth/microsoft/callback', async (c) => {
  const configurationError = validateAuthConfiguration(c.env);

  if (configurationError) {
    return c.json({ error: configurationError }, 500);
  }

  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const storedState = getCookie(c, authStateCookieName);
  deleteCookie(c, authStateCookieName, { path: '/' });

  if (!code || !state || !storedState || state !== storedState) {
    return c.json({ error: 'Invalid Microsoft login callback.' }, 400);
  }

  const db = await requireDatabase(c.env);

  if (!db.ok) {
    return c.json({ error: db.error }, 500);
  }

  try {
    const tokens = await exchangeAuthorizationCode(c.env, code);
    const microsoftUser = await fetchMicrosoftMe(tokens.access_token);
    const ownerMicrosoftEmail = ownerMicrosoftEmailFor(c.env);
    const microsoftEmails = [
      microsoftUser.mail,
      microsoftUser.userPrincipalName,
      ...(microsoftUser.otherMails ?? []),
    ]
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
      .map((value) => value.toLowerCase());

    if (!microsoftEmails.includes(ownerMicrosoftEmail)) {
      return c.json({ error: 'This Microsoft account is not allowed to access the backoffice.' }, 403);
    }

    const existingUser = await findUserByMicrosoftEmail(db.value, ownerMicrosoftEmail);
    const user: UserRecord = {
      id: existingUser?.id ?? crypto.randomUUID(),
      microsoft_email: ownerMicrosoftEmail,
      public_email: ownerPublicEmailFor(c.env),
      role: 'owner',
      name: microsoftUser.displayName ?? existingUser?.name ?? null,
    };

    await upsertOwnerUser(db.value, user);

    if (!c.env.TOKEN_ENCRYPTION_KEY) {
      return c.json({ error: 'OAuth token encryption is not configured.' }, 500);
    }

    await upsertOAuthTokens(db.value, {
      user_id: user.id,
      access_token: await encryptSecret(tokens.access_token, c.env.TOKEN_ENCRYPTION_KEY),
      refresh_token: await encryptSecret(tokens.refresh_token ?? '', c.env.TOKEN_ENCRYPTION_KEY),
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      scope: tokens.scope ?? null,
    });

    const sessionToken = randomToken(32);
    await insertSession(
      db.value,
      await hashSessionToken(c.env, sessionToken),
      user.id,
      new Date(Date.now() + sessionMaxAgeSeconds * 1000).toISOString(),
    );
    setCookie(c, sessionCookieName, sessionToken, buildCookieOptions(c.req.raw, sessionMaxAgeSeconds));

    return c.redirect(backofficeRedirectUrl(c.env, c.req.raw));
  } catch (error) {
    console.error('Microsoft auth callback failed', error);
    return c.json({ error: 'Unable to complete Microsoft login.' }, 502);
  }
});

app.get('/auth/me', async (c) => {
  const user = await readSessionUser(c.env, getCookie(c, sessionCookieName));

  if (!user) {
    return c.json({ authenticated: false });
  }

  return c.json({
    authenticated: true,
    user: {
      email: user.microsoft_email,
      publicEmail: user.public_email,
      role: user.role,
      name: user.name,
    },
  });
});

app.post('/auth/logout', async (c) => {
  const sessionToken = getCookie(c, sessionCookieName);
  const db = c.env.DB;

  if (db && sessionToken) {
    await ensureSchema(db);
    await deleteSession(db, await hashSessionToken(c.env, sessionToken));
  }

  deleteCookie(c, sessionCookieName, { path: '/' });

  return c.json({ ok: true });
});

app.use('/backoffice/*', async (c, next) => {
  const user = await readSessionUser(c.env, getCookie(c, sessionCookieName));

  if (!user || user.role !== 'owner') {
    return c.json({ error: 'Unauthorized.' }, 401);
  }

  c.set('user', user);
  return next();
});

app.get('/backoffice/messages', async (c) => {
  const db = await requireDatabase(c.env);

  if (!db.ok) {
    return c.json({ error: db.error }, 500);
  }

  try {
    const user = c.get('user');
    const accessToken = await getMicrosoftAccessToken(c.env, user.id);
    const messages = await fetchInboxMessages(accessToken, 25);
    const ownerPublicEmail = ownerPublicEmailFor(c.env);
    const threadSummaries = new Map<string, ReturnType<typeof buildMessageSummary>>();

    for (const message of messages) {
      const messageWithHeaders =
        message.internetMessageHeaders?.length || !message.id ? message : await fetchMessage(accessToken, message.id);
      const evidence = findCorporateRecipientEvidence(messageWithHeaders, ownerPublicEmail);

      if (!evidence.ok) {
        continue;
      }

      await cacheMessage(db.value, messageWithHeaders, ownerPublicEmail, evidence.evidence);
      const threadKey = messageWithHeaders.conversationId ?? messageWithHeaders.id;
      const summary = buildMessageSummary(messageWithHeaders, ownerPublicEmail, evidence.evidence);
      const existingSummary = threadSummaries.get(threadKey);

      if (!existingSummary || summary.receivedAt > existingSummary.receivedAt) {
        threadSummaries.set(threadKey, summary);
      }
    }

    return c.json({ messages: [...threadSummaries.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)) });
  } catch (error) {
    console.error('Unable to list backoffice messages', error);
    return c.json({ error: 'Unable to list Outlook messages.' }, 502);
  }
});

app.get('/backoffice/messages/diagnostics/headers', async (c) => {
  try {
    const user = c.get('user');
    const accessToken = await getMicrosoftAccessToken(c.env, user.id);
    const messages = await fetchInboxMessages(accessToken, 10);
    const visibleEmails = [ownerPublicEmailFor(c.env), ownerMicrosoftEmailFor(c.env)];
    const diagnostics = [];

    for (const message of messages) {
      const messageWithHeaders =
        message.internetMessageHeaders?.length || !message.id ? message : await fetchMessage(accessToken, message.id);

      diagnostics.push({
        messageKey: messageWithHeaders.id,
        subject: messageWithHeaders.subject ?? '(sin asunto)',
        receivedAt: messageWithHeaders.receivedDateTime ?? null,
        headers: redactHeaders(messageWithHeaders.internetMessageHeaders, visibleEmails),
      });
    }

    return c.json({ diagnostics });
  } catch (error) {
    console.error('Unable to read diagnostic headers', error);
    return c.json({ error: 'Unable to read Outlook diagnostic headers.' }, 502);
  }
});

app.get('/backoffice/messages/:messageKey', async (c) => {
  const db = await requireDatabase(c.env);

  if (!db.ok) {
    return c.json({ error: db.error }, 500);
  }

  try {
    const user = c.get('user');
    const messageKey = c.req.param('messageKey');
    const cached = await findCachedMessage(db.value, messageKey);
    const graphId = cached?.graph_id ?? decodeKey(messageKey);
    const accessToken = await getMicrosoftAccessToken(c.env, user.id);
    const message = await fetchMessage(accessToken, graphId);
    const ownerPublicEmail = ownerPublicEmailFor(c.env);
    const evidence = findCorporateRecipientEvidence(message, ownerPublicEmail);

    if (!evidence.ok) {
      return c.json({ error: 'Message is outside the owner public mailbox scope.' }, 404);
    }

    await cacheMessage(db.value, message, ownerPublicEmail, evidence.evidence);
    const threadMessages = message.conversationId ? await fetchConversationMessages(accessToken, message.conversationId, 25) : [message];
    const outboundReplies = await findOutboundRepliesForThread(db.value, messageKey, message.conversationId ?? null);

    return c.json({ message: buildMessageDetailWithThread(message, threadMessages, outboundReplies, ownerPublicEmail, evidence.evidence) });
  } catch (error) {
    console.error('Unable to read backoffice message', error);
    return c.json({ error: 'Unable to read Outlook message.' }, 502);
  }
});

app.post('/backoffice/messages/:messageKey/reply', async (c) => {
  const db = await requireDatabase(c.env);

  if (!db.ok) {
    return c.json({ error: db.error }, 500);
  }

  if (!c.env.RESEND_API_KEY) {
    return c.json({ error: 'Email service is not configured.' }, 500);
  }

  const body = await readReplyPayload(c.req.raw);

  if (!body.ok) {
    return c.json({ error: body.error }, 400);
  }

  try {
    const user = c.get('user');
    const messageKey = c.req.param('messageKey');
    const cached = await findCachedMessage(db.value, messageKey);
    const graphId = cached?.graph_id ?? decodeKey(messageKey);
    const accessToken = await getMicrosoftAccessToken(c.env, user.id);
    const message = await fetchMessage(accessToken, graphId);
    const ownerPublicEmail = ownerPublicEmailFor(c.env);
    const evidence = findCorporateRecipientEvidence(message, ownerPublicEmail);

    if (!evidence.ok) {
      return c.json({ error: 'Message is outside the owner public mailbox scope.' }, 404);
    }

    const reply = buildReplyEmail(message, ownerPublicEmail, body.value.message);
    const response = await sendResendEmail(reply.email, c.env.RESEND_API_KEY, reply.idempotencyKey);

    if (!response.ok) {
      const messageText = await response.text();
      console.error('Resend reply error', response.status, messageText);
      return c.json({ error: 'Unable to send reply email.' }, 502);
    }

    const resendResponse = await response.json<{ id?: string }>();
    const createdAt = new Date().toISOString();
    await insertOutboundReply(db.value, {
      id: crypto.randomUUID(),
      messageKey,
      resendEmailId: resendResponse.id ?? null,
      toEmail: reply.toEmail,
      subject: reply.email.subject,
      bodyText: body.value.message,
      createdAt,
    });

    return c.json({ ok: true, id: resendResponse.id ?? null, createdAt });
  } catch (error) {
    console.error('Unable to reply to backoffice message', error);
    return c.json({ error: 'Unable to reply to Outlook message.' }, 502);
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

const readReplyPayload = async (
  request: Request,
): Promise<{ ok: true; value: { message: string } } | { ok: false; error: string }> => {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return { ok: false, error: 'Invalid JSON body.' };
  }

  if (!isRecord(body)) {
    return { ok: false, error: 'Invalid reply payload.' };
  }

  const message = readRequiredString(body, 'message', 8000);

  if (!message) {
    return { ok: false, error: 'Invalid reply payload.' };
  }

  return { ok: true, value: { message } };
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

const sendContactEmail = (emailBody: ResendEmailBody, apiKey: string): Promise<Response> =>
  fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(emailBody),
  });

const validateAuthConfiguration = (env: Env): string | null => {
  if (!env.DB) {
    return 'Database is not configured.';
  }

  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.MICROSOFT_REDIRECT_URI) {
    return 'Microsoft OAuth is not configured.';
  }

  if (!env.SESSION_SECRET) {
    return 'Session secret is not configured.';
  }

  if (!env.TOKEN_ENCRYPTION_KEY) {
    return 'OAuth token encryption is not configured.';
  }

  return null;
};

const requireDatabase = async (env: Env): Promise<{ ok: true; value: D1Database } | { ok: false; error: string }> => {
  if (!env.DB) {
    return { ok: false, error: 'Database is not configured.' };
  }

  await ensureSchema(env.DB);

  return { ok: true, value: env.DB };
};

const readSessionUser = async (env: Env, sessionToken: string | undefined): Promise<UserRecord | null> => {
  if (!env.DB || !sessionToken) {
    return null;
  }

  await ensureSchema(env.DB);

  return findSessionUser(env.DB, await hashSessionToken(env, sessionToken), new Date().toISOString());
};

const hashSessionToken = (env: Env, sessionToken: string): Promise<string> => {
  if (!env.SESSION_SECRET) {
    return sha256Hex(sessionToken);
  }

  return sha256Hex(`${env.SESSION_SECRET}:${sessionToken}`);
};

const buildCookieOptions = (request: Request, maxAge: number) => ({
  httpOnly: true,
  secure: isSecureRequest(request),
  sameSite: 'Lax' as const,
  path: '/',
  maxAge,
});

const isSecureRequest = (request: Request): boolean => {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get('x-forwarded-proto');

  return url.protocol === 'https:' || forwardedProto === 'https';
};

const ownerMicrosoftEmailFor = (env: Env): string => (env.OWNER_MICROSOFT_EMAIL ?? 'juan.mateoc@outlook.com').toLowerCase();

const ownerPublicEmailFor = (env: Env): string => env.OWNER_PUBLIC_EMAIL ?? env.CONTACT_TO_EMAIL ?? 'juanma@ludusales.com';

const backofficeRedirectUrl = (env: Env, request: Request): string => {
  const requestUrl = new URL(request.url);

  if (requestUrl.hostname === 'localhost' || requestUrl.hostname === '127.0.0.1') {
    return 'http://localhost:4200/backoffice';
  }

  return env.FRONTEND_BACKOFFICE_URL ?? 'https://ludusales.com/backoffice';
};

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
