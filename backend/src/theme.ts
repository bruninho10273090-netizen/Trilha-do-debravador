import { z } from 'zod';

/**
 * Cores personalizáveis de cada clube. Cada chave vira uma variável CSS do app
 * (ver `themeCss`); o que o clube não definir usa o padrão do Trilha.
 */
export const THEME_KEYS = {
  background: { label: 'Fundo da página', css: '--bg', def: '#EDF0E7' },
  surface: { label: 'Fundo dos cartões', css: '--surface', def: '#FAFBF6' },
  surfaceAlt: { label: 'Fundo secundário', css: '--surface-2', def: '#E3E8DA' },
  text: { label: 'Texto', css: '--ink', def: '#15231B' },
  muted: { label: 'Texto secundário', css: '--muted', def: '#56655B' },
  border: { label: 'Bordas', css: '--line', def: '#D1D8C8' },
  primary: { label: 'Cor principal (botões)', css: '--pine', def: '#1F5A3C' },
  onPrimary: { label: 'Texto sobre a cor principal', css: '--on-pine', def: '#F4F8F2' },
  header: { label: 'Barra do topo', css: '--bar', def: '#173F2B' },
  onHeader: { label: 'Texto da barra do topo', css: '--on-bar', def: '#EAF2EC' },
  accent: { label: 'Destaque (XP, insígnias)', css: '--gold', def: '#B8820C' },
  accentSoft: { label: 'Fundo de destaque', css: '--gold-bg', def: '#F5E6BD' },
  onAccentSoft: { label: 'Texto sobre o fundo de destaque', css: '--gold-ink', def: '#583C00' },
} as const;

export type ThemeKey = keyof typeof THEME_KEYS;
export type ClubTheme = Record<ThemeKey, string>;

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use uma cor no formato #RRGGBB.').transform((s) => s.toUpperCase());
export const ThemePatch = z.object(
  Object.fromEntries(Object.keys(THEME_KEYS).map((k) => [k, Hex.nullable().optional()])) as Record<ThemeKey, z.ZodOptional<z.ZodNullable<typeof Hex>>>,
).strict();

export const DEFAULT_THEME = Object.fromEntries(
  Object.entries(THEME_KEYS).map(([k, v]) => [k, v.def]),
) as ClubTheme;

export const resolveTheme = (custom: Partial<ClubTheme> | null | undefined): ClubTheme => ({ ...DEFAULT_THEME, ...(custom ?? {}) });

function luminance(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Razão de contraste WCAG entre duas cores (1 a 21). */
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Pares texto/fundo que precisam ser legíveis. */
const PAIRS: [ThemeKey, ThemeKey, number][] = [
  ['text', 'background', 4.5],
  ['text', 'surface', 4.5],
  ['muted', 'surface', 3],
  ['onPrimary', 'primary', 4.5],
  ['onHeader', 'header', 4.5],
  ['onAccentSoft', 'accentSoft', 4.5],
];

/** Avisos de contraste baixo: o tema é salvo, mas a pessoa fica sabendo o que pode ficar ilegível. */
export function contrastWarnings(theme: ClubTheme) {
  return PAIRS.flatMap(([fg, bg, min]) => {
    const ratio = contrast(theme[fg], theme[bg]);
    return ratio < min
      ? [{ foreground: fg, background: bg, ratio: Math.round(ratio * 100) / 100, minimum: min,
          message: `${THEME_KEYS[fg].label} sobre ${THEME_KEYS[bg].label.toLowerCase()} fica difícil de ler.` }]
      : [];
  });
}

/** CSS pronto para o app: sobrescreve as variáveis de cor, inclusive no modo escuro. */
export function themeCss(custom: Partial<ClubTheme>) {
  const t = resolveTheme(custom);
  const vars = (Object.keys(THEME_KEYS) as ThemeKey[]).map((k) => `${THEME_KEYS[k].css}:${t[k]}`).join(';');
  return `:root,:root[data-theme="dark"],:root:not([data-theme="light"]){color-scheme:light;${vars}}\n`;
}
