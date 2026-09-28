// Gera trilha-simulacao.html: o app (index.html) + um servidor de mentira no navegador.
// Uso: node deploy/simulador/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const cat = JSON.parse(readFileSync(join(root, 'backend/src/catalog/catalog.json'), 'utf8'));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[–—-]/g, ' ')
  .replace(/[^a-z0-9 .]/g, ' ').replace(/\s+/g, ' ').trim();

const items = {}, espRefs = {}, espReqs = {};
for (const s of cat.specialties) espReqs[s.id] = s.reqs.length;
for (const it of cat.items) {
  items[it.key] = it.o ? { c: it.cls, o: 1, k: it.k || 1 } : { c: it.cls };
  for (const id of it.esp || []) {
    const ix = it.o ? it.o.findIndex((o) => cat.espByName[norm(o)] === id) : -1;
    (espRefs[id] ||= []).push({ key: it.key, ix: espReqs[id] ? ix : -1 });
  }
}

const css = `<style>
.sim-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px 14px;padding:8px 16px;background:var(--gold-bg);color:var(--gold-ink);font:13px/1.4 var(--f-body);text-align:center}
.sim-bar code{font-weight:700;letter-spacing:.04em}
.sim-bar button{font:inherit;font-weight:600;color:inherit;background:transparent;border:1px solid currentColor;border-radius:999px;padding:3px 12px;cursor:pointer}
</style>`;
const inject = css + '\n<script>window.__TRILHA_CAT__=' + JSON.stringify({ items, espRefs, espReqs }) + ';</script>\n<script>\n'
  + readFileSync(join(here, 'mock-api.js'), 'utf8') + '\n</script>\n';

let html = readFileSync(join(root, 'index.html'), 'utf8');
const at = html.indexOf('<script>');
if (at < 0) throw new Error('script principal não encontrado');
html = html.slice(0, at) + inject + html.slice(at);
html = html.replace('<title>Trilha do Desbravador</title>', '<title>Trilha Simulação</title>');
const out = join(here, 'trilha-simulacao.html');
writeFileSync(out, html);
console.log('ok', out, Math.round(html.length / 1024) + ' KB');
