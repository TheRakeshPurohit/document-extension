import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  startUrl: text('start_url').notNull(),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
});

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  timestamp: integer('timestamp', { mode: 'number' }).notNull(),
  url: text('url').notNull(),
  pageTitle: text('page_title').notNull(),
  metadata: text('metadata').notNull(), // JSON
  screenshotId: text('screenshot_id'),
  altScreenshotId: text('alt_screenshot_id'),
  sortOrder: integer('sort_order').notNull(),
});

export const steps = sqliteTable('steps', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  screenshotId: text('screenshot_id'),
  altScreenshotId: text('alt_screenshot_id'),
  sourceEventIds: text('source_event_ids').notNull().default('[]'), // JSON array
  subSteps: text('sub_steps').notNull().default('[]'), // JSON array of SubStep
  mergeWithNextId: text('merge_with_next_id'),
  isEdited: integer('is_edited', { mode: 'boolean' }).notNull().default(false),
});

export const screenshots = sqliteTable('screenshots', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  filePath: text('file_path').notNull(),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
});
