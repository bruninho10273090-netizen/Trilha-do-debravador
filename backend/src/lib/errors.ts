export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Faça login para continuar.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Você não tem permissão para isso.') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Não encontrado.') => new HttpError(404, 'not_found', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);

/** Violação de índice único do Postgres (o Drizzle embrulha o erro original em `cause`). */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === '23505' || err?.cause?.code === '23505';
}
