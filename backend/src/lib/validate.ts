import { z } from 'zod';
import { badRequest } from './errors.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest('Dados inválidos.', issues);
  }
  return r.data;
}

export const Uuid = z.uuid();
export const Username = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9._-]{3,24}$/, 'Use de 3 a 24 letras, números, ponto, hífen ou sublinhado.')
  .refine((u) => !/^\.+$/.test(u), 'Usuário inválido.');
export const Password = z.string().min(8, 'A senha precisa de pelo menos 8 caracteres.').max(200);
export const PersonName = z.string().trim().min(2).max(80);
export const BirthDate = z.iso.date();
