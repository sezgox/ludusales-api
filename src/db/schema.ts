import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

export const gamifications = sqliteTable(
  'gamifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    publicId: text('public_id').notNull(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    imageKey: text('image_key'),
    startAt: text('start_at').notNull(),
    endAt: text('end_at').notNull(),
    goalValue: integer('goal_value').notNull(),
    valuePrecision: integer('value_precision').notNull(),
    goalUnit: text('goal_unit').notNull(),
    status: text('status', { enum: ['draft', 'active', 'closed'] }).notNull().default('draft'),
    outcome: text('outcome', { enum: ['pending', 'achieved', 'missed'] }).notNull().default('pending'),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    closedAt: text('closed_at'),
  },
  (table) => [
    uniqueIndex('gamifications_public_id_unique').on(table.publicId),
    index('gamifications_company_status_start_idx').on(table.companyId, table.status, table.startAt),
    check('gamifications_dates_check', sql`${table.endAt} > ${table.startAt}`),
    check('gamifications_goal_check', sql`${table.goalValue} >= 0`),
    check('gamifications_precision_check', sql`${table.valuePrecision} BETWEEN 0 AND 6`),
    check(
      'gamifications_state_check',
      sql`(${table.status} = 'closed' AND ${table.outcome} IN ('achieved', 'missed') AND ${table.closedAt} IS NOT NULL)
          OR (${table.status} IN ('draft', 'active') AND ${table.outcome} = 'pending' AND ${table.closedAt} IS NULL)`,
    ),
  ],
);

export const prizes = sqliteTable(
  'prizes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    publicId: text('public_id').notNull(),
    gamificationId: integer('gamification_id')
      .notNull()
      .references(() => gamifications.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    pictureKey: text('picture_key'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('prizes_public_id_unique').on(table.publicId),
    index('prizes_gamification_order_idx').on(table.gamificationId, table.sortOrder, table.id),
    check('prizes_sort_order_check', sql`${table.sortOrder} >= 0`),
  ],
);

export const rankings = sqliteTable(
  'rankings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gamificationId: integer('gamification_id')
      .notNull()
      .references(() => gamifications.id, { onDelete: 'cascade' }),
    externalParticipantId: text('external_participant_id').notNull(),
    fullName: text('full_name').notNull(),
    scoreValue: integer('score_value').notNull(),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('rankings_gamification_participant_unique').on(table.gamificationId, table.externalParticipantId),
    index('rankings_gamification_score_idx').on(table.gamificationId, table.scoreValue),
    check('rankings_score_check', sql`${table.scoreValue} >= 0`),
  ],
);

export const mediaDeletionQueue = sqliteTable('media_deletion_queue', {
  objectKey: text('object_key').primaryKey(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});
