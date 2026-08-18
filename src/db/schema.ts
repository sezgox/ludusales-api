import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const companies = sqliteTable(
  'companies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    publicId: text('public_id').notNull(),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex('companies_public_id_unique').on(table.publicId)],
);

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    publicId: text('public_id').notNull(),
    role: text('role', { enum: ['company', 'superuser'] }).notNull(),
    displayName: text('display_name').notNull(),
    email: text('email'),
    accessCodeHash: text('access_code_hash').notNull(),
    companyId: integer('company_id').references(() => companies.id),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('users_public_id_unique').on(table.publicId),
    uniqueIndex('users_access_code_hash_unique').on(table.accessCodeHash),
    index('users_company_id_idx').on(table.companyId),
  ],
);
