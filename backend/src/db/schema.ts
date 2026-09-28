import { sql } from 'drizzle-orm';
import {
  boolean, date, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['diretor', 'associado', 'conselheiro', 'instrutor', 'desbravador']);
export const membershipStatusEnum = pgEnum('membership_status', ['pendente', 'ativo', 'inativo']);
export const reqStatusEnum = pgEnum('req_status', ['enviado', 'aprovado', 'devolvido']);
export const espStatusEnum = pgEnum('esp_status', ['andamento', 'enviado', 'aprovado', 'devolvido']);

const now = () => timestamp({ withTimezone: true }).notNull().defaultNow();

/** Conta global: a mesma pessoa pode participar de vários clubes. */
export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  username: text().notNull(),
  name: text().notNull(),
  email: text(),
  birth: date(),
  passwordHash: text('password_hash').notNull(),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  createdAt: now(),
  updatedAt: now(),
}, (t) => [
  uniqueIndex('users_username_key').on(sql`lower(${t.username})`),
  uniqueIndex('users_email_key').on(sql`lower(${t.email})`),
]);

/** Sessões com token opaco; só o hash SHA-256 do token fica no banco. */
export const sessions = pgTable('sessions', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  userAgent: text('user_agent'),
  ip: text(),
  createdAt: now(),
  lastUsedAt: now(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [index('sessions_user_idx').on(t.userId)]);

export type ClubSettings = {
  /** Desbravadores que entram pelo código já ficam ativos (a liderança sempre passa por aprovação). */
  autoApproveDesbravadores: boolean;
  /** 'club': qualquer líder aprova qualquer desbravador; 'unit': conselheiro só aprova a própria unidade. */
  counselorScope: 'club' | 'unit';
};

export const DEFAULT_CLUB_SETTINGS: ClubSettings = { autoApproveDesbravadores: true, counselorScope: 'club' };

export const clubs = pgTable('clubs', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  joinCode: text('join_code').notNull().unique(),
  church: text(),
  region: text(),
  settings: jsonb().$type<ClubSettings>().notNull().default(DEFAULT_CLUB_SETTINGS),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: now(),
  updatedAt: now(),
});

export const units = pgTable('units', {
  id: uuid().primaryKey().defaultRandom(),
  clubId: uuid('club_id').notNull().references(() => clubs.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  color: text(),
  createdAt: now(),
}, (t) => [uniqueIndex('units_club_name_key').on(t.clubId, sql`lower(${t.name})`)]);

/** Vínculo de uma conta com um clube: papel, unidade e classe valem por clube. */
export const memberships = pgTable('memberships', {
  id: uuid().primaryKey().defaultRandom(),
  clubId: uuid('club_id').notNull().references(() => clubs.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: roleEnum().notNull(),
  status: membershipStatusEnum().notNull().default('ativo'),
  unitId: uuid('unit_id').references(() => units.id, { onDelete: 'set null' }),
  classId: text('class_id'),
  approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: now(),
  updatedAt: now(),
}, (t) => [
  uniqueIndex('memberships_club_user_key').on(t.clubId, t.userId),
  index('memberships_user_idx').on(t.userId),
]);

/** Um requisito de classe de um desbravador: resposta escrita, opções escolhidas e status. */
export const requirementProgress = pgTable('requirement_progress', {
  membershipId: uuid('membership_id').notNull().references(() => memberships.id, { onDelete: 'cascade' }),
  itemKey: text('item_key').notNull(),
  status: reqStatusEnum(),
  note: text(),
  choice: integer().array(),
  subs: integer().array(),
  comment: text(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: now(),
}, (t) => [
  primaryKey({ columns: [t.membershipId, t.itemKey] }),
  index('req_progress_status_idx').on(t.status),
]);

/** Uma especialidade no caderno do desbravador. */
export const specialtyProgress = pgTable('specialty_progress', {
  membershipId: uuid('membership_id').notNull().references(() => memberships.id, { onDelete: 'cascade' }),
  specialtyId: text('specialty_id').notNull(),
  /** null = tirada do caderno (as respostas continuam guardadas). */
  status: espStatusEnum(),
  customName: text('custom_name'),
  customArea: text('custom_area'),
  answers: jsonb().$type<Record<string, string>>().notNull().default({}),
  done: integer().array().notNull().default([]),
  comment: text(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  updatedAt: now(),
}, (t) => [
  primaryKey({ columns: [t.membershipId, t.specialtyId] }),
  index('esp_progress_status_idx').on(t.status),
]);

export const auditLog = pgTable('audit_log', {
  id: uuid().primaryKey().defaultRandom(),
  clubId: uuid('club_id').references(() => clubs.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  action: text().notNull(),
  targetId: text('target_id'),
  data: jsonb(),
  createdAt: now(),
}, (t) => [index('audit_club_idx').on(t.clubId, t.createdAt)]);

export type Role = (typeof roleEnum.enumValues)[number];
export type User = typeof users.$inferSelect;
export type Club = typeof clubs.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
