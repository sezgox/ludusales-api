import { decryptSecret, encryptSecret } from './security';
import { findOAuthTokens, upsertOAuthTokens } from './db';

export const microsoftScopes = ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Mail.Read'];

export type MicrosoftTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
};

export type MicrosoftUser = {
  id: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
  otherMails?: string[];
};

export type GraphEmailAddress = {
  name?: string;
  address?: string;
};

export type GraphRecipient = {
  emailAddress?: GraphEmailAddress;
};

export type GraphInternetMessageHeader = {
  name?: string;
  value?: string;
};

export type GraphMessage = {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: {
    contentType?: string;
    content?: string;
  };
  from?: {
    emailAddress?: GraphEmailAddress;
  };
  replyTo?: GraphRecipient[];
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  internetMessageId?: string;
  conversationId?: string;
  internetMessageHeaders?: GraphInternetMessageHeader[];
  isRead?: boolean;
};

type GraphMessageCollection = {
  value?: GraphMessage[];
};

export const microsoftTenant = (env: Env): string => env.MICROSOFT_TENANT?.trim() || 'consumers';

export const microsoftAuthorizeUrl = (env: Env, state: string): string => {
  const url = new URL(`https://login.microsoftonline.com/${microsoftTenant(env)}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', env.MICROSOFT_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', env.MICROSOFT_REDIRECT_URI);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', microsoftScopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');

  return url.toString();
};

export const exchangeAuthorizationCode = async (env: Env, code: string): Promise<MicrosoftTokenResponse> =>
  postTokenRequest(env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.MICROSOFT_REDIRECT_URI,
  });

export const refreshAccessToken = async (env: Env, refreshToken: string): Promise<MicrosoftTokenResponse> =>
  postTokenRequest(env, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: microsoftScopes.join(' '),
  });

export const fetchMicrosoftMe = (accessToken: string): Promise<MicrosoftUser> =>
  graphRequest<MicrosoftUser>('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,otherMails', accessToken);

export const getMicrosoftAccessToken = async (env: Env, userId: string): Promise<string> => {
  const db = env.DB;

  if (!db || !env.TOKEN_ENCRYPTION_KEY) {
    throw new Error('OAuth token storage is not configured.');
  }

  const stored = await findOAuthTokens(db, userId);

  if (!stored) {
    throw new Error('Microsoft account is not connected.');
  }

  const expiresAt = Date.parse(stored.expires_at);
  const accessToken = await decryptSecret(stored.access_token, env.TOKEN_ENCRYPTION_KEY);

  if (Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000) {
    return accessToken;
  }

  const refreshToken = await decryptSecret(stored.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  const refreshed = await refreshAccessToken(env, refreshToken);
  const refreshedRefreshToken = refreshed.refresh_token ?? refreshToken;

  await upsertOAuthTokens(db, {
    user_id: userId,
    access_token: await encryptSecret(refreshed.access_token, env.TOKEN_ENCRYPTION_KEY),
    refresh_token: await encryptSecret(refreshedRefreshToken, env.TOKEN_ENCRYPTION_KEY),
    expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    scope: refreshed.scope ?? stored.scope,
  });

  return refreshed.access_token;
};

export const fetchInboxMessages = async (accessToken: string, top = 25): Promise<GraphMessage[]> => {
  const url = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages');
  url.searchParams.set('$top', String(top));
  url.searchParams.set('$orderby', 'receivedDateTime desc');
  url.searchParams.set(
    '$select',
    [
      'id',
      'subject',
      'bodyPreview',
      'from',
      'replyTo',
      'toRecipients',
      'ccRecipients',
      'receivedDateTime',
      'internetMessageId',
      'conversationId',
      'internetMessageHeaders',
      'isRead',
    ].join(','),
  );

  const response = await graphRequest<GraphMessageCollection>(url.toString(), accessToken);

  return response.value ?? [];
};

export const fetchMessage = async (accessToken: string, graphId: string): Promise<GraphMessage> => {
  const url = new URL(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(graphId)}`);
  url.searchParams.set(
    '$select',
    [
      'id',
      'subject',
      'body',
      'bodyPreview',
      'from',
      'replyTo',
      'toRecipients',
      'ccRecipients',
      'receivedDateTime',
      'internetMessageId',
      'conversationId',
      'internetMessageHeaders',
      'isRead',
    ].join(','),
  );

  return graphRequest<GraphMessage>(url.toString(), accessToken, {
    Prefer: 'outlook.body-content-type="html"',
  });
};

export const fetchConversationMessages = async (accessToken: string, conversationId: string, top = 25): Promise<GraphMessage[]> => {
  const url = new URL('https://graph.microsoft.com/v1.0/me/messages');
  url.searchParams.set('$top', String(top));
  url.searchParams.set('$filter', `conversationId eq '${escapeODataString(conversationId)}'`);
  url.searchParams.set(
    '$select',
    [
      'id',
      'subject',
      'body',
      'bodyPreview',
      'from',
      'replyTo',
      'toRecipients',
      'ccRecipients',
      'receivedDateTime',
      'internetMessageId',
      'conversationId',
      'internetMessageHeaders',
      'isRead',
    ].join(','),
  );

  const response = await graphRequest<GraphMessageCollection>(url.toString(), accessToken, {
    Prefer: 'outlook.body-content-type="html"',
  });

  return response.value ?? [];
};

const graphRequest = async <T>(url: string, accessToken: string, headers?: Record<string, string>): Promise<T> => {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...headers,
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Microsoft Graph error ${response.status}: ${message}`);
  }

  return response.json<T>();
};

const escapeODataString = (value: string): string => value.replaceAll("'", "''");

const postTokenRequest = async (env: Env, params: Record<string, string>): Promise<MicrosoftTokenResponse> => {
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.MICROSOFT_REDIRECT_URI) {
    throw new Error('Microsoft OAuth is not configured.');
  }

  const body = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID,
    client_secret: env.MICROSOFT_CLIENT_SECRET,
    ...params,
  });
  const response = await fetch(`https://login.microsoftonline.com/${microsoftTenant(env)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Microsoft token error ${response.status}: ${message}`);
  }

  return response.json<MicrosoftTokenResponse>();
};
