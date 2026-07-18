export type UserRole = 'owner';

export type UserRecord = {
  id: string;
  microsoft_email: string;
  public_email: string;
  role: UserRole;
  name: string | null;
};

export type SessionRecord = {
  token_hash: string;
  user_id: string;
  expires_at: string;
};

export type OAuthTokenRecord = {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string | null;
};

export type CachedMessageRecord = {
  message_key: string;
  graph_id: string;
  internet_message_id: string | null;
  conversation_id: string | null;
  subject: string;
  body_preview: string;
  from_email: string;
  from_name: string;
  reply_to_email: string | null;
  received_at: string;
  evidence: string;
  references_header: string | null;
  is_read: number;
};

export type OutboundReplyRecord = {
  id: string;
  message_key: string;
  resend_email_id: string | null;
  to_email: string;
  subject: string;
  body_text: string;
  created_at: string;
};

const schemaStatements = [
  `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  microsoft_email TEXT NOT NULL UNIQUE,
  public_email TEXT NOT NULL,
  role TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`,
  `
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`,
  `
CREATE TABLE IF NOT EXISTS oauth_tokens (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  scope TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`,
  `
CREATE TABLE IF NOT EXISTS mail_message_cache (
  message_key TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL UNIQUE,
  internet_message_id TEXT,
  conversation_id TEXT,
  subject TEXT NOT NULL,
  body_preview TEXT NOT NULL,
  from_email TEXT NOT NULL,
  from_name TEXT NOT NULL,
  reply_to_email TEXT,
  received_at TEXT NOT NULL,
  evidence TEXT NOT NULL,
  references_header TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`,
  `
CREATE TABLE IF NOT EXISTS outbound_replies (
  id TEXT PRIMARY KEY,
  message_key TEXT NOT NULL,
  resend_email_id TEXT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`,
  'CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_mail_message_cache_received_at ON mail_message_cache(received_at)',
];

let schemaReady: Promise<void> | null = null;

export const ensureSchema = async (db: D1Database): Promise<void> => {
  schemaReady ??= runSchemaStatements(db);
  await schemaReady;
};

const runSchemaStatements = async (db: D1Database): Promise<void> => {
  for (const statement of schemaStatements) {
    await db.prepare(statement).run();
  }
};

export const upsertOwnerUser = async (
  db: D1Database,
  user: UserRecord,
): Promise<void> => {
  await db
    .prepare(
      `
      INSERT INTO users (id, microsoft_email, public_email, role, name)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(microsoft_email) DO UPDATE SET
        public_email = excluded.public_email,
        role = excluded.role,
        name = excluded.name,
        updated_at = CURRENT_TIMESTAMP
      `,
    )
    .bind(user.id, user.microsoft_email, user.public_email, user.role, user.name)
    .run();
};

export const findUserByMicrosoftEmail = (db: D1Database, email: string): Promise<UserRecord | null> =>
  db.prepare('SELECT id, microsoft_email, public_email, role, name FROM users WHERE microsoft_email = ?1').bind(email).first<UserRecord>();

export const findSessionUser = async (
  db: D1Database,
  tokenHash: string,
  nowIso: string,
): Promise<UserRecord | null> =>
  db
    .prepare(
      `
      SELECT users.id, users.microsoft_email, users.public_email, users.role, users.name
      FROM sessions
      INNER JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?1 AND sessions.expires_at > ?2
      `,
    )
    .bind(tokenHash, nowIso)
    .first<UserRecord>();

export const insertSession = (db: D1Database, tokenHash: string, userId: string, expiresAt: string): Promise<D1Result> =>
  db
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)')
    .bind(tokenHash, userId, expiresAt)
    .run();

export const deleteSession = (db: D1Database, tokenHash: string): Promise<D1Result> =>
  db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();

export const upsertOAuthTokens = (db: D1Database, token: OAuthTokenRecord): Promise<D1Result> =>
  db
    .prepare(
      `
      INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, scope)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(user_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        scope = excluded.scope,
        updated_at = CURRENT_TIMESTAMP
      `,
    )
    .bind(token.user_id, token.access_token, token.refresh_token, token.expires_at, token.scope)
    .run();

export const findOAuthTokens = (db: D1Database, userId: string): Promise<OAuthTokenRecord | null> =>
  db
    .prepare('SELECT user_id, access_token, refresh_token, expires_at, scope FROM oauth_tokens WHERE user_id = ?1')
    .bind(userId)
    .first<OAuthTokenRecord>();

export const upsertCachedMessage = (db: D1Database, message: CachedMessageRecord): Promise<D1Result> =>
  db
    .prepare(
      `
      INSERT INTO mail_message_cache (
        message_key, graph_id, internet_message_id, conversation_id, subject, body_preview,
        from_email, from_name, reply_to_email, received_at, evidence, references_header, is_read
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      ON CONFLICT(message_key) DO UPDATE SET
        graph_id = excluded.graph_id,
        internet_message_id = excluded.internet_message_id,
        conversation_id = excluded.conversation_id,
        subject = excluded.subject,
        body_preview = excluded.body_preview,
        from_email = excluded.from_email,
        from_name = excluded.from_name,
        reply_to_email = excluded.reply_to_email,
        received_at = excluded.received_at,
        evidence = excluded.evidence,
        references_header = excluded.references_header,
        is_read = excluded.is_read,
        updated_at = CURRENT_TIMESTAMP
      `,
    )
    .bind(
      message.message_key,
      message.graph_id,
      message.internet_message_id,
      message.conversation_id,
      message.subject,
      message.body_preview,
      message.from_email,
      message.from_name,
      message.reply_to_email,
      message.received_at,
      message.evidence,
      message.references_header,
      message.is_read,
    )
    .run();

export const findCachedMessage = (db: D1Database, messageKey: string): Promise<CachedMessageRecord | null> =>
  db
    .prepare(
      `
      SELECT message_key, graph_id, internet_message_id, conversation_id, subject, body_preview,
        from_email, from_name, reply_to_email, received_at, evidence, references_header, is_read
      FROM mail_message_cache
      WHERE message_key = ?1
      `,
    )
    .bind(messageKey)
    .first<CachedMessageRecord>();

export const insertOutboundReply = (
  db: D1Database,
  reply: {
    id: string;
    messageKey: string;
    resendEmailId: string | null;
    toEmail: string;
    subject: string;
    bodyText: string;
    createdAt: string;
  },
): Promise<D1Result> =>
  db
    .prepare(
      `
      INSERT INTO outbound_replies (id, message_key, resend_email_id, to_email, subject, body_text, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `,
    )
    .bind(reply.id, reply.messageKey, reply.resendEmailId, reply.toEmail, reply.subject, reply.bodyText, reply.createdAt)
    .run();

export const findOutboundRepliesForThread = (
  db: D1Database,
  messageKey: string,
  conversationId: string | null,
): Promise<OutboundReplyRecord[]> => {
  if (!conversationId) {
    return db
      .prepare(
        `
        SELECT id, message_key, resend_email_id, to_email, subject, body_text, created_at
        FROM outbound_replies
        WHERE message_key = ?1
        ORDER BY created_at ASC
        `,
      )
      .bind(messageKey)
      .all<OutboundReplyRecord>()
      .then((result) => result.results);
  }

  return db
    .prepare(
      `
      SELECT outbound_replies.id, outbound_replies.message_key, outbound_replies.resend_email_id,
        outbound_replies.to_email, outbound_replies.subject, outbound_replies.body_text, outbound_replies.created_at
      FROM outbound_replies
      LEFT JOIN mail_message_cache ON mail_message_cache.message_key = outbound_replies.message_key
      WHERE outbound_replies.message_key = ?1 OR mail_message_cache.conversation_id = ?2
      ORDER BY outbound_replies.created_at ASC
      `,
    )
    .bind(messageKey, conversationId)
    .all<OutboundReplyRecord>()
    .then((result) => result.results);
};
