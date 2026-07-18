import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchConversationMessages } from '../src/microsoft';

describe('Microsoft Graph mail requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('filters conversation messages without ordering in Graph', async () => {
    let requestedUrl = '';
    const graphFetch = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrl = String(input);

      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', graphFetch);

    await fetchConversationMessages('access-token', 'conversation-id');

    const url = new URL(requestedUrl);
    expect(url.searchParams.get('$filter')).toBe("conversationId eq 'conversation-id'");
    expect(url.searchParams.has('$orderby')).toBe(false);
  });
});
