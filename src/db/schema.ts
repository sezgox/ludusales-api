import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const blogPosts = sqliteTable('blog_posts', {
  slug: text('slug').primaryKey(),
  category: text('category').notNull(),
  categoryEn: text('category_en').notNull(),
  author: text('author').notNull(),
  publishedAt: text('published_at'),
  featured: integer('featured', { mode: 'boolean' }).notNull().default(false),
  readingMinutes: integer('reading_minutes').notNull(),
  coverLabel: text('cover_label').notNull(),
  coverColor: text('cover_color').notNull(),
  coverStripe: text('cover_stripe').notNull(),
  title: text('title').notNull(),
  titleEn: text('title_en').notNull(),
  excerpt: text('excerpt').notNull(),
  excerptEn: text('excerpt_en').notNull(),
  body: text('body').notNull(),
  bodyEn: text('body_en').notNull(),
});

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
    companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }),
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
    title: text('title').notNull().default('Gamificación'),
    description: text('description').notNull(),
    imageKey: text('image_key'),
    startAt: text('start_at').notNull(),
    endAt: text('end_at').notNull(),
    goalValue: integer('goal_value'),
    valuePrecision: integer('value_precision').notNull(),
    goalUnit: text('goal_unit'),
    rankingUnit: text('ranking_unit').notNull().default('Ludu Points'),
    maxLiveRanking: integer('max_live_ranking').notNull().default(5),
    tvEnabled: integer('tv_enabled', { mode: 'boolean' }).notNull().default(false),
    rankingFieldHeadersJson: text('ranking_field_headers_json').notNull().default('[]'),
    status: text('status', { enum: ['draft', 'active', 'closed'] }).notNull().default('draft'),
    outcome: text('outcome', { enum: ['pending', 'achieved', 'missed', 'not_applicable'] }).notNull().default('pending'),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    closedAt: text('closed_at'),
    actualEndAt: text('actual_end_at'),
  },
  (table) => [
    uniqueIndex('gamifications_public_id_unique').on(table.publicId),
    index('gamifications_company_status_start_idx').on(table.companyId, table.status, table.startAt),
    check('gamifications_dates_check', sql`${table.endAt} > ${table.startAt}`),
    check('gamifications_goal_check', sql`${table.goalValue} IS NULL OR ${table.goalValue} >= 0`),
    check('gamifications_precision_check', sql`${table.valuePrecision} BETWEEN 0 AND 6`),
    check('gamifications_max_live_ranking_check', sql`${table.maxLiveRanking} BETWEEN 3 AND 1000`),
    check(
      'gamifications_state_check',
      sql`(${table.status} = 'closed' AND (
            (${table.goalValue} IS NULL AND ${table.outcome} = 'not_applicable')
            OR (${table.goalValue} IS NOT NULL AND ${table.outcome} IN ('achieved', 'missed'))
          ) AND ${table.closedAt} IS NOT NULL)
          OR (${table.status} IN ('draft', 'active') AND ${table.outcome} = 'pending' AND ${table.closedAt} IS NULL)`,
    ),
  ],
);

export const gamificationRules = sqliteTable(
  'gamification_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gamificationId: integer('gamification_id')
      .notNull()
      .references(() => gamifications.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    iconName: text('icon_name').notNull(),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('gamification_rules_position_unique').on(table.gamificationId, table.position),
    index('gamification_rules_gamification_position_idx').on(table.gamificationId, table.position),
    check('gamification_rules_position_check', sql`${table.position} >= 1`),
  ],
);

export const blockImages = sqliteTable(
  'block_images',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    publicId: text('public_id').notNull(),
    imageKey: text('image_key').notNull(),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex('block_images_public_id_unique').on(table.publicId)],
);

export const gamificationMetricCards = sqliteTable(
  'gamification_metric_cards',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    publicId: text('public_id').notNull(),
    gamificationId: integer('gamification_id').notNull().references(() => gamifications.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    iconName: text('icon_name').notNull(),
    value: text('value').notNull(),
    subvalue: text('subvalue'),
    progressCurrent: text('progress_current'),
    progressMax: text('progress_max'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('gamification_metric_cards_public_id_unique').on(table.publicId),
    index('gamification_metric_cards_order_idx').on(table.gamificationId, table.sortOrder),
  ],
);

export const gamificationPromoCards = sqliteTable(
  'gamification_promo_cards',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    publicId: text('public_id').notNull(),
    gamificationId: integer('gamification_id').notNull().references(() => gamifications.id, { onDelete: 'cascade' }),
    imageId: integer('image_id').notNull().references(() => blockImages.id),
    title: text('title').notNull(),
    description: text('description').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('gamification_promo_cards_public_id_unique').on(table.publicId),
    index('gamification_promo_cards_order_idx').on(table.gamificationId, table.sortOrder),
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
    rankingPosition: integer('ranking_position'),
    kind: text('kind', { enum: ['position', 'milestone', 'zone', 'special', 'raffle'] }).notNull().default('position'),
    description: text('description').notNull().default(''),
    parameter: text('parameter').notNull().default(''),
    estimatedValueCents: integer('estimated_value_cents'),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('prizes_public_id_unique').on(table.publicId),
    index('prizes_gamification_order_idx').on(table.gamificationId, table.rankingPosition, table.id),
    uniqueIndex('prizes_gamification_ranking_position_unique').on(table.gamificationId, table.rankingPosition),
    check('prizes_sort_order_check', sql`${table.sortOrder} >= 0`),
    check('prizes_ranking_position_check', sql`${table.rankingPosition} >= 1`),
    check('prizes_estimated_value_check', sql`${table.estimatedValueCents} >= 0`),
  ],
);

export const rankings = sqliteTable(
  'rankings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gamificationId: integer('gamification_id')
      .notNull()
      .references(() => gamifications.id, { onDelete: 'cascade' }),
    participantId: integer('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    scoreValue: integer('score_value').notNull(),
    customFieldsJson: text('custom_fields_json').notNull().default('{}'),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('rankings_gamification_participant_unique').on(table.gamificationId, table.participantId),
    index('rankings_gamification_score_idx').on(table.gamificationId, table.scoreValue),
    check('rankings_score_check', sql`${table.scoreValue} >= 0`),
  ],
);

export const participants = sqliteTable(
  'participants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    participantCode: text('participant_code').notNull(),
    fullName: text('full_name').notNull(),
    pictureKey: text('picture_key'),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('participants_company_code_unique').on(table.companyId, table.participantCode),
    index('participants_company_name_idx').on(table.companyId, table.fullName),
  ],
);

export const dataUpdates = sqliteTable('data_updates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull().unique(),
  gamificationId: integer('gamification_id').notNull().references(() => gamifications.id, { onDelete: 'cascade' }),
  publishedAt: text('published_at').notNull(),
  valuePrecision: integer('value_precision').notNull(),
  fieldHeadersJson: text('field_headers_json').notNull(),
  status: text('status', { enum: ['published', 'reverted'] }).notNull().default('published'),
  dataDate: text('data_date'),
  importMode: text('import_mode', { enum: ['accumulated', 'period'] }),
  sourceName: text('source_name'),
  authorPublicId: text('author_public_id'),
  projectionJson: text('projection_json'),
  previewToken: text('preview_token'),
}, (table) => [index('data_updates_gamification_status').on(table.gamificationId, table.status, table.id),
  uniqueIndex('data_updates_preview_token').on(table.previewToken).where(sql`${table.previewToken} IS NOT NULL`)]);

export const participantResults = sqliteTable('participant_results', {
  updateId: integer('update_id').notNull().references(() => dataUpdates.id, { onDelete: 'cascade' }),
  participantId: integer('participant_id').notNull().references(() => participants.id, { onDelete: 'cascade' }),
  scoreValue: integer('score_value').notNull(),
  position: integer('position').notNull(),
  customFieldsJson: text('custom_fields_json').notNull(),
  calculationJson: text('calculation_json'),
  sortOrder: integer('sort_order'),
}, (table) => [primaryKey({ columns: [table.updateId, table.participantId] })]);

export const challengeSettings = sqliteTable('challenge_settings', {
  gamificationId: integer('gamification_id').primaryKey().references(() => gamifications.id, { onDelete: 'cascade' }),
  settingsJson: text('settings_json').notNull(),
  revision: text('revision').notNull(),
});

export const challengeMembers = sqliteTable('challenge_members', {
  gamificationId: integer('gamification_id').notNull().references(() => gamifications.id, { onDelete: 'cascade' }),
  participantId: integer('participant_id').notNull().references(() => participants.id, { onDelete: 'cascade' }),
  zone: text('zone').notNull().default(''),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
}, (table) => [primaryKey({ columns: [table.gamificationId, table.participantId] })]);

export const challengeTvAccess = sqliteTable('challenge_tv_access', {
  gamificationId: integer('gamification_id').primaryKey().references(() => gamifications.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
});

export const mediaDeletionQueue = sqliteTable('media_deletion_queue', {
  objectKey: text('object_key').primaryKey(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});
