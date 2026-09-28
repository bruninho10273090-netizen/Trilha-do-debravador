import { eq } from 'drizzle-orm';
import { pbkdf2Sync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema.js';
import { client, newUser, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx?.close(); });
const app = () => ctx.app;

/** Mesmo hash que o app antigo gera no navegador (PBKDF2-SHA256, 120 mil iterações). */
const oldHash = (pw: string, salt: string) => 'p2:' + pbkdf2Sync(Buffer.from(pw), Buffer.from(salt), 120000, 32, 'sha256').toString('hex');

function exportFile() {
  const t = Date.parse('2026-08-10T12:00:00Z');
  return {
    format: 'trilha-export', version: 1, exportedAt: new Date().toISOString(),
    config: { name: 'Clube Águias do Vale', units: [{ id: 'u1', name: 'Leões', color: '#C2621B' }, { id: 'u2', name: 'Panteras', color: '#7A4DA5' }] },
    members: {
      'ana.diretora': { id: 'ana.diretora', username: 'ana.diretora', name: 'Ana Ribeiro', role: 'diretor', unit: null, status: 'ativo', salt: 'aa11', hash: oldHash('senha1', 'aa11'), progress: {} },
      lucas: {
        id: 'lucas', username: 'lucas', name: 'Lucas Almeida', role: 'desbravador', unit: 'u1', birth: '2014-03-15', classId: 'pesquisador', status: 'ativo',
        salt: 'bb22cc33', hash: oldHash('lucas123', 'bb22cc33'),
        progress: {
          pesquisador_I_1: { s: 'aprovado', at: t, by: 'ana.diretora' },
          pesquisador_I_2: { s: 'devolvido', at: t, by: 'ana.diretora', cm: 'Conte como participa da Classe Bíblica.' },
          pesquisador_I_3: { s: 'enviado', at: t, choice: [2] },
          requisito_que_nao_existe: { s: 'aprovado', at: t },
        },
        esp: { felinos: { s: 'aprovado', at: t, by: 'ana.diretora' }, 'x-violao-k3j9': { s: 'andamento', at: t, name: 'Violão', area: 'HM' } },
      },
      sofia: { id: 'sofia', username: 'sofia', name: 'Sofia Carvalho', role: 'desbravador', unit: 'u2', birth: '2016-05-02', status: 'ativo', salt: 'x', hash: 'f1:abc123', progress: {} },
      paulo: { id: 'paulo', username: 'paulo.cons', name: 'Paulo Mendes', role: 'conselheiro', unit: 'u1', status: 'pendente', salt: 'dd44', hash: oldHash('paulo123', 'dd44') },
    },
    notes: { lucas: { m: 'lucas', t: { pesquisador_I_3: 'A Lei fala de pureza e lealdade.', pesquisador_II_1: 'Rascunho ainda não enviado.' } } },
    answers: { 'lucas~felinos': { m: 'lucas', e: 'felinos', a: { r0: 'Família Felidae', r99: 'ignorar' }, d: [0, 1, 2] }, 'lucas~x-violao-k3j9': { a: { r0: 'Aprendi 10 acordes.' }, d: [] } },
  };
}

describe('importar clube do app antigo', () => {
  it('recria o clube com membros, senhas, cartões e caderno', async () => {
    // alguém já usa o nome "lucas" no servidor
    await newUser(app(), { username: 'lucas' });
    const ana = await newUser(app(), { name: 'Ana Ribeiro', username: 'ana.servidor' });

    const r = await ana.post('/clubs/import', { data: exportFile(), me: 'ana.diretora' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ members: 4, club: { name: 'Clube Águias do Vale' } });
    expect(r.body.renamed).toEqual([expect.objectContaining({ from: 'lucas', to: 'lucas-2' })]);
    expect(r.body.withoutPassword).toEqual([{ name: 'Sofia Carvalho', username: 'sofia' }]);
    const clubId = r.body.club.id;

    // quem importou é o administrador e continua com a própria conta
    const info = (await ana.get(`/clubs/${clubId}`)).body;
    expect(info.isAdmin).toBe(true);
    expect(info.subscription.state).toBe('trial');
    expect(info.units.map((u: { name: string }) => u.name).sort()).toEqual(['Leões', 'Panteras']);

    const members = (await ana.get(`/clubs/${clubId}/members`)).body.members;
    const lucas = members.find((m: { name: string }) => m.name === 'Lucas Almeida');
    expect(lucas).toMatchObject({ username: 'lucas-2', role: 'desbravador', classId: 'pesquisador', status: 'ativo' });
    expect(members.find((m: { name: string }) => m.name === 'Paulo Mendes').status).toBe('pendente');

    // o desbravador entra com a senha que já usava; ela passa para o formato novo
    const login = await client(app()).post('/auth/login', { username: 'lucas-2', password: 'lucas123' });
    expect(login.status).toBe(200);
    const [row] = await ctx.db.select().from(users).where(eq(users.username, 'lucas-2'));
    expect(row.passwordHash.startsWith('scrypt$')).toBe(true);
    expect((await client(app()).post('/auth/login', { username: 'lucas-2', password: 'lucas123' })).status).toBe(200);
    expect((await client(app()).post('/auth/login', { username: 'lucas-2', password: 'errada' })).status).toBe(401);
    // quem não tinha senha compatível não entra até a diretoria criar uma
    expect((await client(app()).post('/auth/login', { username: 'sofia', password: 'qualquer' })).status).toBe(401);

    // cartão e caderno
    const kid = client(app(), login.body.token);
    const prog = (await kid.get(`/clubs/${clubId}/members/${lucas.id}/progress`)).body;
    const req = Object.fromEntries(prog.requirements.map((q: { itemKey: string }) => [q.itemKey, q]));
    expect(req.pesquisador_I_1).toMatchObject({ status: 'aprovado', reviewedBy: ana.user.id });
    expect(req.pesquisador_I_2).toMatchObject({ status: 'devolvido', comment: 'Conte como participa da Classe Bíblica.' });
    expect(req.pesquisador_I_3).toMatchObject({ status: 'enviado', choice: [2], note: 'A Lei fala de pureza e lealdade.' });
    expect(req.pesquisador_II_1).toMatchObject({ status: null, note: 'Rascunho ainda não enviado.' });
    expect(req.requisito_que_nao_existe).toBeUndefined();
    const esp = Object.fromEntries(prog.specialties.map((e: { specialtyId: string }) => [e.specialtyId, e]));
    expect(esp.felinos).toMatchObject({ status: 'aprovado', answers: { r0: 'Família Felidae' }, done: [0, 1, 2] });
    expect(esp['custom-violao-k3j9']).toMatchObject({ status: 'andamento', customName: 'Violão', customArea: 'HM', answers: { r0: 'Aprendi 10 acordes.' } });
    expect(prog.stats.xp).toBe(10 + 50);
  });

  it('sem escolher "quem é você", quem importa entra como diretor e administrador', async () => {
    const u = await newUser(app());
    const data = exportFile();
    data.config.name = 'Clube Importado Sem Mim';
    // nomes já importados no teste anterior ganham final novo
    const r = await u.post('/clubs/import', { data });
    expect(r.status).toBe(201);
    expect(r.body.renamed.length).toBeGreaterThanOrEqual(3);
    const info = (await u.get(`/clubs/${r.body.club.id}`)).body;
    expect(info).toMatchObject({ isAdmin: true, membership: { role: 'diretor' } });
    expect((await u.get(`/clubs/${r.body.club.id}/members`)).body.members).toHaveLength(5);
  });

  it('recusa arquivo que não é do app', async () => {
    const u = await newUser(app());
    expect((await u.post('/clubs/import', { data: { foo: 1 } })).status).toBe(400);
    expect((await u.post('/clubs/import', { data: exportFile(), me: 'ninguem' })).status).toBe(400);
    expect((await client(app()).post('/clubs/import', { data: exportFile() })).status).toBe(401);
  });
});
