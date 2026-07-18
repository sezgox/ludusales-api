import { CachedMessageRecord, OutboundReplyRecord, upsertCachedMessage } from './db';
import { GraphInternetMessageHeader, GraphMessage, GraphRecipient } from './microsoft';
import { encodeKey, escapeHtml, randomToken } from './security';

export type BackofficeMessageSummary = {
  messageKey: string;
  subject: string;
  bodyPreview: string;
  from: {
    name: string;
    email: string;
  };
  replyToEmail: string | null;
  receivedAt: string;
  isRead: boolean;
  evidence: string;
};

export type BackofficeMessageDetail = BackofficeMessageSummary & {
  bodyHtml: string;
  threadSegments: MessageThreadSegment[];
  threadMessages: MessageThreadMessage[];
  internetMessageId: string | null;
  referencesHeader: string | null;
};

export type MessageThreadSegment = {
  kind: 'latest' | 'quoted';
  label: string;
  html: string;
};

export type MessageThreadMessage = {
  messageKey: string;
  direction: 'inbound' | 'outbound' | 'quoted';
  from: {
    name: string;
    email: string;
  };
  receivedAt: string;
  bodyHtml: string;
  isSelected: boolean;
};

export type RecipientEvidence = {
  ok: true;
  evidence: string;
} | {
  ok: false;
};

type ResendEmailBody = {
  from: string;
  to: string[];
  reply_to?: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
};

const acceptedHeaderNames = new Set([
  'delivered-to',
  'envelope-to',
  'original-to',
  'x-original-to',
  'x-forwarded-to',
  'apparently-to',
]);

export const buildMessageSummary = (message: GraphMessage, ownerPublicEmail: string, evidence: string): BackofficeMessageSummary => {
  const from = message.from?.emailAddress;

  return {
    messageKey: encodeKey(message.id),
    subject: normalizeSubject(message.subject),
    bodyPreview: message.bodyPreview ?? '',
    from: {
      name: from?.name ?? from?.address ?? 'Remitente desconocido',
      email: from?.address ?? '',
    },
    replyToEmail: readReplyToEmail(message),
    receivedAt: message.receivedDateTime ?? new Date(0).toISOString(),
    isRead: message.isRead ?? false,
    evidence: evidence || `recipient:${ownerPublicEmail}`,
  };
};

export const buildMessageDetail = (
  message: GraphMessage,
  ownerPublicEmail: string,
  evidence: string,
): BackofficeMessageDetail => ({
  ...buildMessageSummary(message, ownerPublicEmail, evidence),
  bodyHtml: message.body?.content ?? `<p>${escapeHtml(message.bodyPreview ?? '')}</p>`,
  threadSegments: buildThreadSegments(message),
  threadMessages: [buildThreadMessage(message, message.id)],
  internetMessageId: message.internetMessageId ?? null,
  referencesHeader: findHeader(message.internetMessageHeaders, 'references') ?? null,
});

export const buildMessageDetailWithThread = (
  message: GraphMessage,
  threadMessages: GraphMessage[],
  outboundReplies: OutboundReplyRecord[],
  ownerPublicEmail: string,
  evidence: string,
): BackofficeMessageDetail => {
  const detail = buildMessageDetail(message, ownerPublicEmail, evidence);
  const uniqueThreadMessages = dedupeMessages(threadMessages.length > 0 ? threadMessages : [message]);
  const quotedOriginMessage = buildQuotedOriginMessage(uniqueThreadMessages[0], ownerPublicEmail);
  const combinedThreadMessages = [
    ...(quotedOriginMessage ? [quotedOriginMessage] : []),
    ...uniqueThreadMessages.map((threadMessage) => buildThreadMessage(threadMessage, message.id)),
    ...outboundReplies.map((reply) => buildOutboundThreadMessage(reply, ownerPublicEmail)),
  ].sort(compareThreadMessagesByDate);

  return {
    ...detail,
    threadMessages: combinedThreadMessages,
  };
};

export const cacheMessage = async (
  db: D1Database,
  message: GraphMessage,
  ownerPublicEmail: string,
  evidence: string,
): Promise<void> => {
  const summary = buildMessageSummary(message, ownerPublicEmail, evidence);

  await upsertCachedMessage(db, {
    message_key: summary.messageKey,
    graph_id: message.id,
    internet_message_id: message.internetMessageId ?? null,
    conversation_id: message.conversationId ?? null,
    subject: summary.subject,
    body_preview: summary.bodyPreview,
    from_email: summary.from.email,
    from_name: summary.from.name,
    reply_to_email: summary.replyToEmail,
    received_at: summary.receivedAt,
    evidence: summary.evidence,
    references_header: findHeader(message.internetMessageHeaders, 'references') ?? null,
    is_read: summary.isRead ? 1 : 0,
  });
};

export const cachedRecordToSummary = (record: CachedMessageRecord): BackofficeMessageSummary => ({
  messageKey: record.message_key,
  subject: record.subject,
  bodyPreview: record.body_preview,
  from: {
    name: record.from_name,
    email: record.from_email,
  },
  replyToEmail: record.reply_to_email,
  receivedAt: record.received_at,
  isRead: record.is_read === 1,
  evidence: record.evidence,
});

export const findCorporateRecipientEvidence = (message: GraphMessage, ownerPublicEmail: string): RecipientEvidence => {
  const email = ownerPublicEmail.toLowerCase();

  if (recipientsContain(message.toRecipients, email)) {
    return { ok: true, evidence: 'toRecipients' };
  }

  if (recipientsContain(message.ccRecipients, email)) {
    return { ok: true, evidence: 'ccRecipients' };
  }

  const headers = message.internetMessageHeaders ?? [];

  for (const header of headers) {
    const name = header.name?.toLowerCase();
    const value = header.value?.toLowerCase() ?? '';

    if (!name || !value.includes(email)) {
      continue;
    }

    if (acceptedHeaderNames.has(name)) {
      return { ok: true, evidence: `header:${header.name}` };
    }

    if (name === 'received' && new RegExp(`\\bfor\\s+<?${escapeRegExp(email)}>?`, 'i').test(value)) {
      return { ok: true, evidence: 'header:Received-for' };
    }
  }

  return { ok: false };
};

export const buildReplyEmail = (
  message: GraphMessage,
  ownerPublicEmail: string,
  text: string,
): { email: ResendEmailBody; idempotencyKey: string; toEmail: string } => {
  const toEmail = readReplyToEmail(message) || message.from?.emailAddress?.address;

  if (!toEmail) {
    throw new Error('The original message does not have a reply recipient.');
  }

  const subject = normalizeReplySubject(message.subject);
  const internetMessageId = message.internetMessageId;
  const references = buildReferencesHeader(message);
  const headers: Record<string, string> = {};

  if (internetMessageId) {
    headers['In-Reply-To'] = internetMessageId;
  }

  if (references) {
    headers['References'] = references;
  }

  return {
    email: {
      from: `Ludus Sales <${ownerPublicEmail}>`,
      to: [toEmail],
      reply_to: ownerPublicEmail,
      subject,
      text,
      html: textToHtml(text),
      headers,
    },
    idempotencyKey: `reply-${encodeKey(message.id)}-${randomToken(12)}`,
    toEmail,
  };
};

export const sendResendEmail = (emailBody: ResendEmailBody, apiKey: string, idempotencyKey?: string): Promise<Response> =>
  fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(emailBody),
  });

export const findHeader = (headers: GraphInternetMessageHeader[] | undefined, name: string): string | undefined => {
  const lowerName = name.toLowerCase();

  return headers?.find((header) => header.name?.toLowerCase() === lowerName)?.value;
};

export const redactHeaders = (
  headers: GraphInternetMessageHeader[] | undefined,
  visibleEmails: string[],
): GraphInternetMessageHeader[] => {
  const visible = new Set(visibleEmails.map((email) => email.toLowerCase()));

  return (headers ?? []).map((header) => ({
    name: header.name,
    value: (header.value ?? '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) =>
      visible.has(email.toLowerCase()) ? email : '[email-redacted]',
    ),
  }));
};

const recipientsContain = (recipients: GraphRecipient[] | undefined, lowerEmail: string): boolean =>
  (recipients ?? []).some((recipient) => recipient.emailAddress?.address?.toLowerCase() === lowerEmail);

const readReplyToEmail = (message: GraphMessage): string | null =>
  message.replyTo?.find((recipient) => recipient.emailAddress?.address)?.emailAddress?.address ??
  message.from?.emailAddress?.address ??
  null;

const buildReferencesHeader = (message: GraphMessage): string | null => {
  const internetMessageId = message.internetMessageId;
  const references = findHeader(message.internetMessageHeaders, 'references');

  if (!internetMessageId) {
    return references ?? null;
  }

  if (!references) {
    return internetMessageId;
  }

  return references.includes(internetMessageId) ? references : `${references} ${internetMessageId}`;
};

const normalizeSubject = (subject: string | undefined): string => subject?.trim() || '(sin asunto)';

const normalizeReplySubject = (subject: string | undefined): string => {
  const normalized = normalizeSubject(subject);

  return normalized.toLowerCase().startsWith('re:') ? normalized : `Re: ${normalized}`;
};

const buildThreadSegments = (message: GraphMessage): MessageThreadSegment[] => {
  const bodyHtml = message.body?.content ?? `<p>${escapeHtml(message.bodyPreview ?? '')}</p>`;
  const knownHtmlQuote = splitKnownHtmlQuote(bodyHtml);

  if (knownHtmlQuote) {
    return [
      {
        kind: 'latest',
        label: 'Ultimo correo recibido',
        html: knownHtmlQuote.latest,
      },
      {
        kind: 'quoted',
        label: 'Historial del hilo',
        html: knownHtmlQuote.quoted,
      },
    ];
  }

  const text = htmlToText(bodyHtml);
  const textQuote = splitTextQuote(text);

  if (textQuote) {
    return [
      {
        kind: 'latest',
        label: 'Ultimo correo recibido',
        html: textToHtml(textQuote.latest),
      },
      {
        kind: 'quoted',
        label: 'Historial del hilo',
        html: textToHtml(textQuote.quoted),
      },
    ];
  }

  return [
    {
      kind: 'latest',
      label: 'Ultimo correo recibido',
      html: bodyHtml,
    },
  ];
};

const buildThreadMessage = (message: GraphMessage, selectedGraphId: string): MessageThreadMessage => {
  const from = message.from?.emailAddress;
  const segments = buildThreadSegments(message);
  const latest = segments.find((segment) => segment.kind === 'latest') ?? segments[0];

  return {
    messageKey: encodeKey(message.id),
    direction: 'inbound',
    from: {
      name: from?.name ?? from?.address ?? 'Remitente desconocido',
      email: from?.address ?? '',
    },
    receivedAt: message.receivedDateTime ?? new Date(0).toISOString(),
    bodyHtml: latest?.html ?? `<p>${escapeHtml(message.bodyPreview ?? '')}</p>`,
    isSelected: message.id === selectedGraphId,
  };
};

const buildOutboundThreadMessage = (reply: OutboundReplyRecord, ownerPublicEmail: string): MessageThreadMessage => ({
  messageKey: `outbound-${reply.id}`,
  direction: 'outbound',
  from: {
    name: 'Ludus Sales',
    email: ownerPublicEmail,
  },
  receivedAt: normalizeTimelineDate(reply.created_at),
  bodyHtml: textToHtml(reply.body_text),
  isSelected: false,
});

const buildQuotedOriginMessage = (message: GraphMessage | undefined, ownerPublicEmail: string): MessageThreadMessage | null => {
  if (!message) {
    return null;
  }

  const quoted = buildThreadSegments(message).find((segment) => segment.kind === 'quoted');

  if (!quoted) {
    return null;
  }

  return {
    messageKey: `quoted-${encodeKey(message.id)}`,
    direction: 'quoted',
    from: {
      name: 'Ludus Sales',
      email: ownerPublicEmail,
    },
    receivedAt: message.receivedDateTime ?? new Date(0).toISOString(),
    bodyHtml: quoted.html,
    isSelected: false,
  };
};

const dedupeMessages = (messages: GraphMessage[]): GraphMessage[] => {
  const seen = new Set<string>();
  const uniqueMessages = [];

  for (const message of messages) {
    if (seen.has(message.id)) {
      continue;
    }

    seen.add(message.id);
    uniqueMessages.push(message);
  }

  return uniqueMessages.sort((a, b) => (a.receivedDateTime ?? '').localeCompare(b.receivedDateTime ?? ''));
};

const compareThreadMessagesByDate = (a: MessageThreadMessage, b: MessageThreadMessage): number => {
  const diff = timestampForTimelineDate(a.receivedAt) - timestampForTimelineDate(b.receivedAt);

  if (diff !== 0) {
    return diff;
  }

  if (a.direction === 'quoted' && b.direction !== 'quoted') {
    return -1;
  }

  if (a.direction !== 'quoted' && b.direction === 'quoted') {
    return 1;
  }

  return a.messageKey.localeCompare(b.messageKey);
};

const normalizeTimelineDate = (value: string): string => {
  const trimmed = value.trim();

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(trimmed)) {
    const withSeconds = trimmed.length === 16 ? `${trimmed}:00` : trimmed;

    return `${withSeconds.replace(' ', 'T')}Z`;
  }

  return trimmed;
};

const timestampForTimelineDate = (value: string): number => {
  const timestamp = Date.parse(normalizeTimelineDate(value));

  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const splitKnownHtmlQuote = (html: string): { latest: string; quoted: string } | null => {
  const match = /<(?:div|blockquote)[^>]+(?:class|id)=["'][^"']*(?:gmail_quote|yahoo_quoted|moz-cite-prefix|appendonsend|divRplyFwdMsg)[^"']*["'][^>]*>/i.exec(
    html,
  );

  if (!match || match.index < 1) {
    return null;
  }

  const latest = html.slice(0, match.index).trim();
  const quoted = html.slice(match.index).trim();

  if (!hasVisibleText(latest) || !hasVisibleText(quoted)) {
    return null;
  }

  return { latest, quoted };
};

const splitTextQuote = (text: string): { latest: string; quoted: string } | null => {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const markerIndex = lines.findIndex((line, index) => index > 0 && isQuoteMarker(line));

  if (markerIndex < 1) {
    return null;
  }

  const latest = lines.slice(0, markerIndex).join('\n').trim();
  const quoted = lines.slice(markerIndex).join('\n').trim();

  if (!latest || !quoted) {
    return null;
  }

  return { latest, quoted };
};

const isQuoteMarker = (line: string): boolean => {
  const trimmed = line.trim();

  if (/^El\s+.+\sescribi/i.test(trimmed) && trimmed.endsWith(':')) {
    return true;
  }

  return (
    /^El\s+.+\sescribi[oó]:$/i.test(trimmed) ||
    /^On\s+.+\swrote:$/i.test(trimmed) ||
    /^De:\s.+/i.test(trimmed) ||
    /^From:\s.+/i.test(trimmed) ||
    /^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed) ||
    /^-{2,}\s*Mensaje original\s*-{2,}$/i.test(trimmed)
  );
};

const htmlToText = (html: string): string =>
  decodeHtmlEntities(
    html
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

const hasVisibleText = (html: string): boolean => htmlToText(html).trim().length > 0;

const textToHtml = (text: string): string =>
  text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br />')}</p>`)
    .join('');

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
