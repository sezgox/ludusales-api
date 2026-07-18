import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildMessageDetail, buildMessageDetailWithThread, buildReplyEmail, findCorporateRecipientEvidence, sendResendEmail } from '../src/mail';
import { GraphMessage } from '../src/microsoft';

describe('backoffice mail helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes messages sent to the corporate recipient', () => {
    const message: GraphMessage = {
      id: '1',
      toRecipients: [{ emailAddress: { address: 'juanma@ludusales.com' } }],
    };

    expect(findCorporateRecipientEvidence(message, 'juanma@ludusales.com')).toEqual({
      ok: true,
      evidence: 'toRecipients',
    });
  });

  it('includes messages with preserved forwarding headers', () => {
    const message: GraphMessage = {
      id: '1',
      toRecipients: [{ emailAddress: { address: 'juan.mateoc@outlook.com' } }],
      internetMessageHeaders: [{ name: 'X-Original-To', value: 'juanma@ludusales.com' }],
    };

    expect(findCorporateRecipientEvidence(message, 'juanma@ludusales.com')).toEqual({
      ok: true,
      evidence: 'header:X-Original-To',
    });
  });

  it('hides direct Outlook messages without corporate evidence', () => {
    const message: GraphMessage = {
      id: '1',
      toRecipients: [{ emailAddress: { address: 'juan.mateoc@outlook.com' } }],
      internetMessageHeaders: [{ name: 'Delivered-To', value: 'juan.mateoc@outlook.com' }],
    };

    expect(findCorporateRecipientEvidence(message, 'juanma@ludusales.com')).toEqual({ ok: false });
  });

  it('separates the latest reply from quoted thread text', () => {
    const message: GraphMessage = {
      id: '1',
      subject: 'Re: Hemos recibido tu solicitud en Ludus Sales',
      body: {
        contentType: 'html',
        content:
          '<div>Perfe<br><br>El vie, 17 jul 2026 a las 12:47, Ludus Sales (&lt;juanma@ludusales.com&gt;) escribió:<br>Hola Sergio,<br>Gracias</div>',
      },
      from: { emailAddress: { address: 'elias@example.com', name: 'Sergio' } },
      receivedDateTime: '2026-07-17T10:48:00.000Z',
    };
    const detail = buildMessageDetail(message, 'juanma@ludusales.com', 'toRecipients');

    expect(detail.threadSegments).toHaveLength(2);
    expect(detail.threadSegments[0]).toEqual(
      expect.objectContaining({
        kind: 'latest',
        html: '<p>Perfe</p>',
      }),
    );
    expect(detail.threadSegments[1]).toEqual(
      expect.objectContaining({
        kind: 'quoted',
      }),
    );
    expect(detail.threadSegments[1]?.html).toContain('escribió');
  });

  it('builds a full conversation timeline from graph messages', () => {
    const selected: GraphMessage = {
      id: 'selected',
      subject: 'Re: Demo',
      body: {
        contentType: 'html',
        content: '<div>Tercer mensaje<br><br>El vie, Ludus Sales escribió:<br>Segundo mensaje</div>',
      },
      from: { emailAddress: { address: 'lead@example.com', name: 'Lead' } },
      receivedDateTime: '2026-07-17T12:00:00.000Z',
    };
    const previous: GraphMessage = {
      id: 'previous',
      subject: 'Re: Demo',
      body: {
        contentType: 'html',
        content: '<div>Primer mensaje visible</div>',
      },
      from: { emailAddress: { address: 'lead@example.com', name: 'Lead' } },
      receivedDateTime: '2026-07-17T10:00:00.000Z',
    };

    const detail = buildMessageDetailWithThread(selected, [selected, previous], [], 'juanma@ludusales.com', 'toRecipients');

    expect(detail.threadMessages.map((message) => message.messageKey)).toEqual(['cHJldmlvdXM', 'c2VsZWN0ZWQ']);
    expect(detail.threadMessages[0]?.bodyHtml).toContain('Primer mensaje visible');
    expect(detail.threadMessages[1]?.bodyHtml).toBe('<p>Tercer mensaje</p>');
    expect(detail.threadMessages[1]?.isSelected).toBe(true);
  });

  it('adds the quoted original message when Graph does not include the sent confirmation', () => {
    const firstReply: GraphMessage = {
      id: 'first-reply',
      subject: 'Re: Hemos recibido tu solicitud en Ludus Sales',
      body: {
        contentType: 'html',
        content:
          '<div>Perfe<br><br>El vie, 17 jul 2026 a las 12:47, Ludus Sales (&lt;juanma@ludusales.com&gt;) escribiÃ³:<br>Hola Sergio,<br>Hemos recibido tu solicitud.</div>',
      },
      from: { emailAddress: { address: 'elias@example.com', name: 'Sergio' } },
      receivedDateTime: '2026-07-17T12:48:00.000Z',
    };
    const detail = buildMessageDetailWithThread(firstReply, [firstReply], [], 'juanma@ludusales.com', 'toRecipients');

    expect(detail.threadMessages).toHaveLength(2);
    expect(detail.threadMessages[0]).toEqual(
      expect.objectContaining({
        direction: 'quoted',
        from: {
          name: 'Ludus Sales',
          email: 'juanma@ludusales.com',
        },
      }),
    );
    expect(detail.threadMessages[0]?.bodyHtml).toContain('Hemos recibido tu solicitud');
    expect(detail.threadMessages[1]).toEqual(
      expect.objectContaining({
        direction: 'inbound',
        bodyHtml: '<p>Perfe</p>',
      }),
    );
  });

  it('adds outbound Resend replies to the conversation timeline', () => {
    const selected: GraphMessage = {
      id: 'selected',
      subject: 'Re: Demo',
      body: {
        contentType: 'html',
        content: '<div>Mensaje recibido</div>',
      },
      from: { emailAddress: { address: 'lead@example.com', name: 'Lead' } },
      receivedDateTime: '2026-07-17T10:00:00.000Z',
    };
    const detail = buildMessageDetailWithThread(
      selected,
      [selected],
      [
        {
          id: 'reply-id',
          message_key: 'selected',
          resend_email_id: 'resend-id',
          to_email: 'lead@example.com',
          subject: 'Re: Demo',
          body_text: 'Respuesta de Juanma',
          created_at: '2026-07-17T11:00:00.000Z',
        },
      ],
      'juanma@ludusales.com',
      'toRecipients',
    );

    expect(detail.threadMessages).toHaveLength(2);
    expect(detail.threadMessages[1]).toEqual(
      expect.objectContaining({
        direction: 'outbound',
        from: {
          name: 'Ludus Sales',
          email: 'juanma@ludusales.com',
        },
        bodyHtml: '<p>Respuesta de Juanma</p>',
      }),
    );
  });

  it('normalizes legacy D1 reply timestamps before sorting the thread', () => {
    const selected: GraphMessage = {
      id: 'selected',
      subject: 'Re: Demo',
      body: {
        contentType: 'html',
        content: '<div>Que onda!</div>',
      },
      from: { emailAddress: { address: 'lead@example.com', name: 'Lead' } },
      receivedDateTime: '2026-07-18T19:18:00.000Z',
    };
    const detail = buildMessageDetailWithThread(
      selected,
      [selected],
      [
        {
          id: 'reply-id',
          message_key: 'selected',
          resend_email_id: 'resend-id',
          to_email: 'lead@example.com',
          subject: 'Re: Demo',
          body_text: 'Respuesta posterior',
          created_at: '2026-07-18 19:31:00',
        },
      ],
      'juanma@ludusales.com',
      'toRecipients',
    );

    expect(detail.threadMessages.map((message) => message.bodyHtml)).toEqual(['<div>Que onda!</div>', '<p>Respuesta posterior</p>']);
    expect(detail.threadMessages[1]?.receivedAt).toBe('2026-07-18T19:31:00Z');
  });

  it('builds Resend reply headers for the original thread', async () => {
    const message: GraphMessage = {
      id: 'graph-id',
      subject: 'Demo',
      internetMessageId: '<original@example.com>',
      from: { emailAddress: { address: 'lead@example.com', name: 'Lead' } },
      internetMessageHeaders: [{ name: 'References', value: '<previous@example.com>' }],
    };
    const reply = buildReplyEmail(message, 'juanma@ludusales.com', 'Hola');

    expect(reply.email).toEqual(
      expect.objectContaining({
        from: 'Ludus Sales <juanma@ludusales.com>',
        to: ['lead@example.com'],
        reply_to: 'juanma@ludusales.com',
        subject: 'Re: Demo',
        headers: {
          'In-Reply-To': '<original@example.com>',
          References: '<previous@example.com> <original@example.com>',
        },
      }),
    );

    const resendFetch = vi.fn(async () => new Response(JSON.stringify({ id: 'resend-id' }), { status: 200 }));
    vi.stubGlobal('fetch', resendFetch);

    await sendResendEmail(reply.email, 'test-key', 'idempotency-key');

    expect(resendFetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Idempotency-Key': 'idempotency-key',
        }),
      }),
    );
  });
});
