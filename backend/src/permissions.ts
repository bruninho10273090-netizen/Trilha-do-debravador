import type { Club, Membership, Role, User } from './db/schema.js';

export const ROLES: Role[] = ['diretor', 'associado', 'conselheiro', 'instrutor', 'desbravador'];
export const LEADER_ROLES: Role[] = ['diretor', 'associado', 'conselheiro', 'instrutor'];
export const ADMIN_ROLES: Role[] = ['diretor', 'associado'];

/**
 * Permissões por função dentro de um clube. O administrador do clube (dono) e o
 * administrador da plataforma têm todas; as marcadas com [] são exclusivas deles.
 * Regras finas (quem pode mexer em quem) ficam nas funções abaixo.
 */
export const PERMISSIONS = {
  'club.view': ROLES,
  'club.update': ADMIN_ROLES,
  'club.delete': [],
  'club.joinCode': ADMIN_ROLES,
  'units.manage': ADMIN_ROLES,
  'members.viewAll': LEADER_ROLES,
  'members.manage': ADMIN_ROLES,
  'progress.review': LEADER_ROLES,
  'audit.view': ADMIN_ROLES,
  'club.branding': [],
  'club.billing': [],
  'club.transfer': [],
} satisfies Record<string, Role[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Contexto de quem faz a requisição dentro de um clube. */
export type ClubCtx = { user: User; club: Club; membership: Membership | null };

const active = (m: Membership | null): m is Membership => !!m && m.status === 'ativo';

/** É o administrador (dono) do clube? */
export const isOwner = (ctx: ClubCtx) => active(ctx.membership) && ctx.club.ownerId === ctx.user.id;

export function can(ctx: ClubCtx, perm: Permission): boolean {
  if (ctx.user.isPlatformAdmin || isOwner(ctx)) return true;
  return active(ctx.membership) && (PERMISSIONS[perm] as Role[]).includes(ctx.membership.role);
}

export const isLeader = (ctx: ClubCtx) => can(ctx, 'progress.review');

/**
 * Pode alterar função/unidade/status ou remover o vínculo `target`?
 * Ninguém além do próprio administrador mexe no vínculo do administrador; associado
 * não mexe em diretor nem promove alguém a diretor; ninguém muda a própria função
 * (exceto o administrador).
 */
export function canManageMember(ctx: ClubCtx, target: Membership, newRole?: Role): boolean {
  if (!can(ctx, 'members.manage')) return false;
  if (ctx.user.isPlatformAdmin || isOwner(ctx)) return true;
  if (target.userId === ctx.club.ownerId) return false;
  const me = ctx.membership!;
  if (target.id === me.id && newRole && newRole !== me.role) return false;
  if (me.role === 'associado' && (target.role === 'diretor' || newRole === 'diretor')) return false;
  return true;
}

/** Pode aprovar/devolver o que `target` enviou? */
export function canReview(ctx: ClubCtx, target: Membership): boolean {
  if (!can(ctx, 'progress.review')) return false;
  if (ctx.user.isPlatformAdmin) return true;
  const me = ctx.membership!;
  if (target.id === me.id) return false;
  if (isOwner(ctx)) return true;
  if (me.role === 'conselheiro' && ctx.club.settings.counselorScope === 'unit' && me.unitId) {
    return target.unitId === me.unitId;
  }
  return true;
}

/** Pode escrever respostas e enviar requisitos no cartão de `target` (ele mesmo ou um líder por ele)? */
export function canEditCard(ctx: ClubCtx, target: Membership): boolean {
  if (active(ctx.membership) && ctx.membership.id === target.id) return true;
  return canReview(ctx, target);
}

/** O caderno de especialidades é pessoal: só o próprio desbravador escreve nele. */
export function canEditNotebook(ctx: ClubCtx, target: Membership): boolean {
  return active(ctx.membership) && ctx.membership.id === target.id;
}
