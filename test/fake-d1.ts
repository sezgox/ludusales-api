type BoundStatement = {
  sql: string;
  values: unknown[];
};

type UserRow = {
  id: string;
  microsoft_email: string;
  public_email: string;
  role: 'owner';
  name: string | null;
};

type SessionRow = {
  token_hash: string;
  user_id: string;
  expires_at: string;
};

type TokenRow = {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string | null;
};

type MessageRow = {
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

export class FakeD1 {
  readonly users = new Map<string, UserRow>();
  readonly sessions = new Map<string, SessionRow>();
  readonly tokens = new Map<string, TokenRow>();
  readonly messages = new Map<string, MessageRow>();
  readonly replies: unknown[][] = [];

  asD1(): D1Database {
    return this as unknown as D1Database;
  }

  exec(_sql: string): Promise<D1ExecResult> {
    return Promise.resolve({ count: 0, duration: 0 });
  }

  prepare(sql: string) {
    return new FakePreparedStatement(this, sql);
  }
}

class FakePreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): FakePreparedStatement {
    this.values = values;

    return this;
  }

  first<T>(): Promise<T | null> {
    const statement: BoundStatement = { sql: this.sql, values: this.values };
    const normalized = statement.sql.replace(/\s+/g, ' ').trim().toLowerCase();

    if (normalized.includes('from users where microsoft_email')) {
      const email = String(statement.values[0]);

      return Promise.resolve((this.db.users.get(email) ?? null) as T | null);
    }

    if (normalized.includes('from sessions inner join users')) {
      const tokenHash = String(statement.values[0]);
      const nowIso = String(statement.values[1]);
      const session = this.db.sessions.get(tokenHash);

      if (!session || session.expires_at <= nowIso) {
        return Promise.resolve(null);
      }

      return Promise.resolve((this.db.users.get(session.user_id) ?? null) as T | null);
    }

    if (normalized.includes('from oauth_tokens where user_id')) {
      const userId = String(statement.values[0]);

      return Promise.resolve((this.db.tokens.get(userId) ?? null) as T | null);
    }

    if (normalized.includes('from mail_message_cache')) {
      const messageKey = String(statement.values[0]);

      return Promise.resolve((this.db.messages.get(messageKey) ?? null) as T | null);
    }

    return Promise.resolve(null);
  }

  run(): Promise<D1Result> {
    const statement: BoundStatement = { sql: this.sql, values: this.values };
    const normalized = statement.sql.replace(/\s+/g, ' ').trim().toLowerCase();

    if (normalized.startsWith('insert into users')) {
      const row: UserRow = {
        id: String(statement.values[0]),
        microsoft_email: String(statement.values[1]),
        public_email: String(statement.values[2]),
        role: 'owner',
        name: statement.values[4] === null ? null : String(statement.values[4]),
      };
      this.db.users.set(row.microsoft_email, row);
      this.db.users.set(row.id, row);
    }

    if (normalized.startsWith('insert into sessions')) {
      const row: SessionRow = {
        token_hash: String(statement.values[0]),
        user_id: String(statement.values[1]),
        expires_at: String(statement.values[2]),
      };
      this.db.sessions.set(row.token_hash, row);
    }

    if (normalized.startsWith('delete from sessions')) {
      this.db.sessions.delete(String(statement.values[0]));
    }

    if (normalized.startsWith('insert into oauth_tokens')) {
      const row: TokenRow = {
        user_id: String(statement.values[0]),
        access_token: String(statement.values[1]),
        refresh_token: String(statement.values[2]),
        expires_at: String(statement.values[3]),
        scope: statement.values[4] === null ? null : String(statement.values[4]),
      };
      this.db.tokens.set(row.user_id, row);
    }

    if (normalized.startsWith('insert into mail_message_cache')) {
      const row: MessageRow = {
        message_key: String(statement.values[0]),
        graph_id: String(statement.values[1]),
        internet_message_id: statement.values[2] === null ? null : String(statement.values[2]),
        conversation_id: statement.values[3] === null ? null : String(statement.values[3]),
        subject: String(statement.values[4]),
        body_preview: String(statement.values[5]),
        from_email: String(statement.values[6]),
        from_name: String(statement.values[7]),
        reply_to_email: statement.values[8] === null ? null : String(statement.values[8]),
        received_at: String(statement.values[9]),
        evidence: String(statement.values[10]),
        references_header: statement.values[11] === null ? null : String(statement.values[11]),
        is_read: Number(statement.values[12]),
      };
      this.db.messages.set(row.message_key, row);
    }

    if (normalized.startsWith('insert into outbound_replies')) {
      this.db.replies.push(statement.values);
    }

    return Promise.resolve({
      results: [],
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0,
      },
    });
  }
}
