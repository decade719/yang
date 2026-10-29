import { sqliteTable, text, integer, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey().notNull(),
  nickname: text('nickname').notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at').notNull(),
  clientHash: text('client_hash').notNull(),
  contentHash: text('content_hash').notNull(),
  sessionNonce: text('session_nonce').notNull().unique(),
}, table => [
  index('messages_chronological').on(table.createdAt, table.id),
  index('messages_client_time').on(table.clientHash, table.createdAt),
  index('messages_duplicate').on(table.clientHash, table.contentHash, table.createdAt),
  check('nickname_length', sql`length(${table.nickname}) BETWEEN 1 AND 24`),
  check('content_length', sql`length(${table.content}) BETWEEN 2 AND 500`),
]);
