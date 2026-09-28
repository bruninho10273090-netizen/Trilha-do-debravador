// Extrai o catálogo (classes, requisitos e especialidades) do index.html do app
// para src/catalog/catalog.json. Rode de novo sempre que o cartão mudar no front:
//   npm run catalog
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../..', import.meta.url));
const html = readFileSync(root + 'index.html', 'utf8');

const start = html.indexOf('const SECTIONS=');
const end = html.indexOf('function espAbbr(');
if (start < 0 || end < 0) throw new Error('Bloco do catálogo não encontrado no index.html');

const code = html.slice(start, end) + `
;globalThis.__out = {
  sections: SECTIONS, roman: ROMAN, areas: AREAS,
  xp: { reg: XP_REG, adv: XP_ADV, bonusReg: BONUS_REG, bonusAdv: BONUS_ADV, esp: XP_ESP },
  classes: CLASSES.map(c => ({ id: c.id, name: c.name, age: c.age, adv: c.adv })),
  items: Object.keys(ITEM).map(k => {
    const it = ITEM[k];
    return { key: k, cls: it.cls, sec: it.sec, n: it.n, adv: it.adv, xp: it.xp, t: it.t,
      o: it.o || null, k: it.k || (it.o ? 1 : null), a: it.a || null, i: it.i || null, w: !!it.w,
      esp: ITEM_ESP[k] || null };
  }),
  specialties: ESP.map(e => ({ id: e.id, name: e.n, area: e.a, code: e.c, reqs: e.r })),
  espByName: ESP_BY_NAME
};`;

const ctx = {};
vm.createContext(ctx);
vm.runInContext(code, ctx);
const out = ctx.__out;
writeFileSync(new URL('../src/catalog/catalog.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(`catálogo: ${out.classes.length} classes, ${out.items.length} requisitos, ${out.specialties.length} especialidades`);
