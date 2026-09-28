import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const Env = z.object({
  DATABASE_URL: z.string().default('postgres://trilha:trilha@localhost:5432/trilha'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z.string().default(''),
  SESSION_DAYS: z.coerce.number().int().min(1).default(30),
  SERVE_FRONTEND: bool.default(true),
  RATE_LIMIT: bool.default(true),
  TRIAL_DAYS: z.coerce.number().int().min(0).default(14),
  LOGO_MAX_KB: z.coerce.number().int().min(16).max(5120).default(1024),
  ADMIN_CLAIM_CODE: z.string().default(''),
  NODE_ENV: z.string().default('development'),
});

export type Config = {
  databaseUrl: string;
  port: number;
  host: string;
  corsOrigins: string[];
  sessionDays: number;
  serveFrontend: boolean;
  rateLimit: boolean;
  trialDays: number;
  logoMaxBytes: number;
  /** Código secreto que transforma a conta logada em administradora da plataforma (vazio = desligado). */
  adminClaimCode: string;
  isProd: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    host: e.HOST,
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    sessionDays: e.SESSION_DAYS,
    serveFrontend: e.SERVE_FRONTEND,
    rateLimit: e.RATE_LIMIT,
    trialDays: e.TRIAL_DAYS,
    logoMaxBytes: e.LOGO_MAX_KB * 1024,
    adminClaimCode: e.ADMIN_CLAIM_CODE.trim().length >= 12 ? e.ADMIN_CLAIM_CODE.trim() : '',
    isProd: e.NODE_ENV === 'production',
  };
}
