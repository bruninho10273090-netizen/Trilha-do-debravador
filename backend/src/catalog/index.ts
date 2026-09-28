import data from './catalog.json' with { type: 'json' };

export type CatalogItem = {
  key: string; cls: string; sec: string; n: number; adv: boolean; xp: number; t: string;
  o: string[] | null; k: number | null; a: string[] | null; i: string | null; w: boolean; esp: string[] | null;
};
export type Specialty = { id: string; name: string; area: string; code: string; reqs: string[] };

export const catalog = data as unknown as {
  sections: Record<string, string>;
  roman: string[];
  areas: Record<string, { n: string; c: string }>;
  xp: { reg: number; adv: number; bonusReg: number; bonusAdv: number; esp: number };
  classes: { id: string; name: string; age: number; adv: string }[];
  items: CatalogItem[];
  specialties: Specialty[];
  espByName: Record<string, string>;
};

export const ITEMS = new Map(catalog.items.map((it) => [it.key, it]));
export const SPECIALTIES = new Map(catalog.specialties.map((s) => [s.id, s]));
export const CLASS_IDS = catalog.classes.map((c) => c.id);

/** Requisitos de classe que são cumpridos ao aprovar a especialidade. */
export const ESP_REFS = new Map<string, string[]>();
for (const it of catalog.items) for (const id of it.esp ?? []) ESP_REFS.set(id, [...(ESP_REFS.get(id) ?? []), it.key]);

export const CUSTOM_PREFIX = 'custom-';
export const isCustomSpecialty = (id: string) => id.startsWith(CUSTOM_PREFIX) && /^custom-[a-z0-9-]{1,60}$/.test(id);

export function ageOf(birth: string | null | undefined, today = new Date()): number | null {
  if (!birth) return null;
  const d = new Date(birth + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return null;
  let a = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) a--;
  return a;
}

export function classForAge(age: number | null): string {
  if (age == null) return 'amigo';
  return CLASS_IDS[Math.max(0, Math.min(CLASS_IDS.length - 1, age - 10))];
}

const LV = [0, 50, 120, 210, 320, 450, 600, 780, 1000, 1250, 1550, 1900, 2300, 2750, 3250, 3800, 4400, 5000];
const TITLES = ['Recruta', 'Recruta', 'Explorador', 'Explorador', 'Rastreador', 'Rastreador', 'Trilheiro', 'Trilheiro',
  'Batedor', 'Batedor', 'Sentinela', 'Sentinela', 'Guardião da Mata', 'Guardião da Mata', 'Guardião da Mata',
  'Lenda da Trilha', 'Lenda da Trilha', 'Lenda da Trilha'];

export function levelOf(xp: number) {
  let l = 1;
  while (l < LV.length && xp >= LV[l]) l++;
  return { level: l, title: TITLES[l - 1] };
}

/** Mesma conta de XP do app: requisitos aprovados + bônus por classe completa + especialidades. */
export function computeStats(
  reqs: { itemKey: string; status: string | null }[],
  esps: { specialtyId: string; status: string | null }[],
) {
  const approvedKeys = new Set(reqs.filter((r) => r.status === 'aprovado').map((r) => r.itemKey));
  let xp = 0, approved = 0, regDone = 0, advDone = 0;
  const pending = reqs.filter((r) => r.status === 'enviado' && ITEMS.has(r.itemKey)).length;
  for (const c of catalog.classes) {
    const reg = catalog.items.filter((it) => it.cls === c.id && !it.adv);
    const av = catalog.items.filter((it) => it.cls === c.id && it.adv);
    for (const it of [...reg, ...av]) if (approvedKeys.has(it.key)) { xp += it.xp; approved++; }
    if (reg.every((it) => approvedKeys.has(it.key))) { regDone++; xp += catalog.xp.bonusReg; }
    if (av.every((it) => approvedKeys.has(it.key))) { advDone++; xp += catalog.xp.bonusAdv; }
  }
  const espDone = esps.filter((e) => e.status === 'aprovado').length;
  xp += espDone * catalog.xp.esp;
  return { xp, approved, pending, regDone, advDone, espDone, ...levelOf(xp) };
}
