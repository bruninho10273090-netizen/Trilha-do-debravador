import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, newUser, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx?.close(); });

const app = () => ctx.app;

/** Clube com diretor, um desbravador e uma unidade. */
async function clubWithKid(name = 'Clube Águias') {
  const dir = await newUser(app(), { name: 'Ana Diretora' });
  const club = (await dir.post('/clubs', { name })).body.club;
  const unit = (await dir.post(`/clubs/${club.id}/units`, { name: 'Leões' })).body.unit;
  const code = (await dir.get(`/clubs/${club.id}`)).body.club.joinCode;
  const kid = await newUser(app(), { name: 'Lucas', birth: '2014-03-10' });
  const kidM = (await kid.post('/clubs/join', { code, unitId: unit.id })).body.membership;
  return { dir, club, unit, code, kid, kidM };
}

describe('contas e sessão', () => {
  it('cadastra, entra, mostra /me e sai', async () => {
    const u = await newUser(app(), { username: 'maria.silva' });
    expect(u.user.username).toBe('maria.silva');
    expect(u.user).not.toHaveProperty('passwordHash');

    const bad = await client(app()).post('/auth/login', { username: 'maria.silva', password: 'errada' });
    expect(bad.status).toBe(401);
    const ok = await client(app()).post('/auth/login', { username: 'MARIA.SILVA', password: 'senha-forte-123' });
    expect(ok.status).toBe(200);

    const me = await client(app(), ok.body.token).get('/auth/me');
    expect(me.body.user.username).toBe('maria.silva');

    expect((await client(app(), ok.body.token).post('/auth/logout')).status).toBe(204);
    expect((await client(app(), ok.body.token).get('/auth/me')).status).toBe(401);
  });

  it('recusa usuário repetido e senha curta', async () => {
    await newUser(app(), { username: 'repetido' });
    const dup = await client(app()).post('/auth/register', { username: 'Repetido', name: 'Outro', password: 'senha-forte-123' });
    expect(dup.status).toBe(409);
    const short = await client(app()).post('/auth/register', { username: 'curta', name: 'Curta', password: '123' });
    expect(short.status).toBe(400);
  });

  it('trocar a senha derruba as outras sessões', async () => {
    const u = await newUser(app(), { username: 'troca.senha' });
    const other = (await client(app()).post('/auth/login', { username: 'troca.senha', password: 'senha-forte-123' })).body.token;
    expect((await u.post('/auth/password', { current: 'senha-forte-123', password: 'nova-senha-456' })).status).toBe(204);
    expect((await client(app(), other).get('/auth/me')).status).toBe(401);
    expect((await u.get('/auth/me')).status).toBe(200);
  });
});

describe('clubes e convites', () => {
  it('quem cria vira diretor; desbravador entra ativo pelo código; liderança fica pendente', async () => {
    const { dir, club, code, kidM } = await clubWithKid();
    const me = await dir.get('/auth/me');
    expect(me.body.clubs[0]).toMatchObject({ role: 'diretor', status: 'ativo', club: { id: club.id } });
    expect(kidM).toMatchObject({ role: 'desbravador', status: 'ativo', classId: expect.any(String) });

    const lider = await newUser(app());
    const pend = (await lider.post('/clubs/join', { code, role: 'conselheiro' })).body.membership;
    expect(pend.status).toBe('pendente');
    // pendente ainda não enxerga o clube
    expect((await lider.get(`/clubs/${club.id}`)).status).toBe(404);
    expect((await dir.post(`/clubs/${club.id}/members/${pend.id}/approve`)).status).toBe(200);
    expect((await lider.get(`/clubs/${club.id}`)).status).toBe(200);
  });

  it('não dá para pedir entrada como diretor nem entrar duas vezes', async () => {
    const { kid, code } = await clubWithKid();
    expect((await kid.post('/clubs/join', { code })).status).toBe(409);
    const x = await newUser(app());
    expect((await x.post('/clubs/join', { code, role: 'diretor' })).status).toBe(400);
  });

  it('código do clube só aparece para a diretoria e pode ser trocado', async () => {
    const { dir, kid, club, code } = await clubWithKid();
    expect((await kid.get(`/clubs/${club.id}`)).body.club.joinCode).toBeUndefined();
    const rotated = (await dir.post(`/clubs/${club.id}/join-code`)).body.joinCode;
    expect(rotated).not.toBe(code);
    const late = await newUser(app());
    expect((await late.post('/clubs/join', { code })).status).toBe(404);
  });

  it('quem é de fora recebe 404 no clube', async () => {
    const { club } = await clubWithKid();
    const stranger = await newUser(app());
    expect((await stranger.get(`/clubs/${club.id}`)).status).toBe(404);
    expect((await stranger.get(`/clubs/${club.id}/members`)).status).toBe(404);
  });

  it('a mesma conta tem papéis diferentes em clubes diferentes', async () => {
    const a = await clubWithKid('Clube A');
    const b = await clubWithKid('Clube B');
    // diretor do A entra no B como instrutor (pendente → aprovado)
    const m = (await a.dir.post('/clubs/join', { code: b.code, role: 'instrutor' })).body.membership;
    await b.dir.post(`/clubs/${b.club.id}/members/${m.id}/approve`);
    const clubs = (await a.dir.get('/auth/me')).body.clubs;
    expect(clubs.map((c: { role: string }) => c.role).sort()).toEqual(['diretor', 'instrutor']);
    // no B ele revisa, mas não administra
    expect((await a.dir.post(`/clubs/${b.club.id}/units`, { name: 'Nova' })).status).toBe(403);
    expect((await a.dir.post(`/clubs/${b.club.id}/members/${b.kidM.id}/requirements/amigo_I_1/approve`)).status).toBe(200);
    // e o diretor do B não enxerga nada do A
    expect((await b.dir.get(`/clubs/${a.club.id}/members`)).status).toBe(404);
  });
});

describe('gestão de membros', () => {
  it('o clube nunca fica sem diretor', async () => {
    const { dir, club } = await clubWithKid();
    const myM = (await dir.get(`/clubs/${club.id}`)).body.membership;
    expect((await dir.post(`/clubs/${club.id}/leave`)).status).toBe(403);
    expect((await dir.patch(`/clubs/${club.id}/members/${myM.id}`, { role: 'associado' })).status).toBe(403);
  });

  it('associado administra, mas não mexe em diretor', async () => {
    const { dir, club } = await clubWithKid();
    const dirM = (await dir.get(`/clubs/${club.id}`)).body.membership;
    const assoc = (await dir.post(`/clubs/${club.id}/members`, { username: 'assoc1', name: 'Bia Associada', password: 'senha-forte-123', role: 'associado' })).body.member;
    const tok = (await client(app()).post('/auth/login', { username: 'assoc1', password: 'senha-forte-123' })).body.token;
    const as = client(app(), tok);
    expect((await as.post(`/clubs/${club.id}/units`, { name: 'Tigres' })).status).toBe(201);
    expect((await as.patch(`/clubs/${club.id}/members/${dirM.id}`, { role: 'conselheiro' })).status).toBe(403);
    expect((await as.post(`/clubs/${club.id}/members`, { username: 'novo.dir', name: 'Novo Dir', password: 'senha-forte-123', role: 'diretor' })).status).toBe(403);
    expect((await as.del(`/clubs/${club.id}/members/${dirM.id}`)).status).toBe(403);
    expect(assoc.role).toBe('associado');
  });

  it('desbravador vê a lista sem dados pessoais e não administra', async () => {
    const { kid, club, kidM } = await clubWithKid();
    const list = (await kid.get(`/clubs/${club.id}/members`)).body.members;
    expect(list.length).toBe(2);
    expect(list[0]).not.toHaveProperty('birth');
    expect((await kid.patch(`/clubs/${club.id}/members/${kidM.id}`, { role: 'diretor' })).status).toBe(403);
    expect((await kid.post(`/clubs/${club.id}/units`, { name: 'X' })).status).toBe(403);
  });

  it('diretoria redefine senha só de quem é só deste clube', async () => {
    const a = await clubWithKid('Clube Senha A');
    const b = await clubWithKid('Clube Senha B');
    expect((await a.dir.post(`/clubs/${a.club.id}/members/${a.kidM.id}/password`, { password: 'outra-senha-99' })).status).toBe(204);
    // a redefinição derruba as sessões antigas
    expect((await a.kid.get('/auth/me')).status).toBe(401);
    const login = await client(app()).post('/auth/login', { username: a.kid.username, password: 'outra-senha-99' });
    expect(login.status).toBe(200);
    // o desbravador do A entra também no B: agora o A não pode mais trocar a senha dele
    expect((await client(app(), login.body.token).post('/clubs/join', { code: b.code })).status).toBe(201);
    expect((await a.dir.post(`/clubs/${a.club.id}/members/${a.kidM.id}/password`, { password: 'mais-uma-senha' })).status).toBe(403);
  });
});

describe('cartão de classe', () => {
  it('fluxo enviar → devolver → reenviar → aprovar, com XP', async () => {
    const { dir, kid, club, kidM } = await clubWithKid();
    const base = `/clubs/${club.id}/members/${kidM.id}`;
    const key = 'amigo_I_3';
    expect((await kid.patch(`${base}/requirements/${key}`, { note: 'Pela graça de Deus...' })).status).toBe(200);
    expect((await kid.post(`${base}/requirements/${key}/submit`)).body.requirement.status).toBe('enviado');
    expect((await kid.patch(`${base}/requirements/${key}`, { note: 'mudei' })).status).toBe(400);

    const queue = (await dir.get(`/clubs/${club.id}/approvals`)).body;
    expect(queue.requirements).toHaveLength(1);
    expect(queue.requirements[0].member.name).toBe('Lucas');

    const ret = await dir.post(`${base}/requirements/${key}/return`, { comment: 'Explique a Lei também.' });
    expect(ret.body.requirement).toMatchObject({ status: 'devolvido', comment: 'Explique a Lei também.' });
    await kid.post(`${base}/requirements/${key}/submit`);
    expect((await kid.post(`${base}/requirements/${key}/approve`)).status).toBe(403);
    expect((await dir.post(`${base}/requirements/${key}/approve`)).body.requirement.status).toBe('aprovado');

    const prog = (await kid.get(`${base}/progress`)).body;
    expect(prog.stats).toMatchObject({ xp: 10, approved: 1, level: 1 });
  });

  it('requisito com opções exige a escolha antes de enviar', async () => {
    const { kid, club, kidM } = await clubWithKid();
    const base = `/clubs/${club.id}/members/${kidM.id}/requirements/amigo_III_1`;
    expect((await kid.post(`${base}/submit`)).status).toBe(400);
    expect((await kid.patch(base, { choice: [0, 1, 2] })).status).toBe(400); // pede 2
    await kid.patch(base, { choice: [0, 2] });
    expect((await kid.post(`${base}/submit`)).status).toBe(200);
  });

  it('um desbravador não mexe no cartão de outro', async () => {
    const { club, code, kidM } = await clubWithKid();
    const other = await newUser(app());
    await other.post('/clubs/join', { code });
    expect((await other.patch(`/clubs/${club.id}/members/${kidM.id}/requirements/amigo_I_3`, { note: 'x' })).status).toBe(403);
    expect((await other.get(`/clubs/${club.id}/members/${kidM.id}/progress`)).status).toBe(403);
  });

  it('conselheiro com escopo de unidade só aprova a própria unidade', async () => {
    const { dir, club, code, kidM, unit } = await clubWithKid();
    await dir.patch(`/clubs/${club.id}`, { settings: { counselorScope: 'unit' } });
    const other = (await dir.post(`/clubs/${club.id}/units`, { name: 'Panteras' })).body.unit;
    const cons = await newUser(app());
    const cm = (await cons.post('/clubs/join', { code, role: 'conselheiro', unitId: other.id })).body.membership;
    await dir.post(`/clubs/${club.id}/members/${cm.id}/approve`);
    const url = `/clubs/${club.id}/members/${kidM.id}/requirements/amigo_I_3/approve`;
    expect((await cons.post(url)).status).toBe(403);
    await dir.patch(`/clubs/${club.id}/members/${cm.id}`, { unitId: unit.id });
    expect((await cons.post(url)).status).toBe(200);
  });
});

describe('caderno de especialidades', () => {
  it('aprovar a especialidade cumpre o requisito de classe ligado', async () => {
    const { dir, kid, club, kidM } = await clubWithKid();
    const base = `/clubs/${club.id}/members/${kidM.id}/specialties/felinos`;
    const r = await kid.patch(base, { answers: { r0: 'Família Felidae' } });
    expect(r.body.specialty.status).toBe('andamento');
    expect((await kid.post(`${base}/submit`)).status).toBe(400); // faltam requisitos marcados
    const total = (await client(app()).get('/catalog')).body.specialties.find((s: { id: string }) => s.id === 'felinos').reqs.length;
    await kid.patch(base, { done: Array.from({ length: total }, (_, i) => i) });
    expect((await kid.post(`${base}/submit`)).body.specialty.status).toBe('enviado');
    expect((await dir.patch(base, { answers: { r0: 'x' } })).status).toBe(403); // caderno é pessoal

    const ap = (await dir.post(`${base}/approve`)).body;
    expect(ap.specialty.status).toBe('aprovado');
    // Amigo VII.1 pede uma de: Felinos, Cães, ...
    expect(ap.linkedRequirements).toEqual([expect.objectContaining({ itemKey: 'amigo_VII_1', status: 'aprovado', choice: [0] })]);
    const stats = (await kid.get(`/clubs/${club.id}/members/${kidM.id}/progress`)).body.stats;
    expect(stats.xp).toBe(50 + 10);
  });

  it('especialidade personalizada precisa de nome e resposta', async () => {
    const { kid, club, kidM } = await clubWithKid();
    const base = `/clubs/${club.id}/members/${kidM.id}/specialties/custom-violao`;
    expect((await kid.patch(base, { answers: { r0: 'x' } })).status).toBe(400);
    expect((await kid.patch(base, { customName: 'Violão', customArea: 'HM' })).status).toBe(200);
    expect((await kid.post(`${base}/submit`)).status).toBe(400);
    await kid.patch(base, { answers: { r0: 'Aprendi 10 acordes.' } });
    expect((await kid.post(`${base}/submit`)).status).toBe(200);
  });

  it('especialidade inexistente dá 404', async () => {
    const { kid, club, kidM } = await clubWithKid();
    expect((await kid.patch(`/clubs/${club.id}/members/${kidM.id}/specialties/nao-existe`, { done: [0] })).status).toBe(404);
  });
});

describe('ranking e auditoria', () => {
  it('ranking por XP e registro das ações', async () => {
    const { dir, kid, club, kidM } = await clubWithKid();
    await dir.post(`/clubs/${club.id}/members/${kidM.id}/requirements/approve`, { keys: ['amigo_I_1', 'amigo_I_2'] });
    const rank = (await kid.get(`/clubs/${club.id}/ranking`)).body;
    expect(rank.members[0]).toMatchObject({ name: 'Lucas', xp: 20 });
    expect(rank.units[0]).toMatchObject({ name: 'Leões', avgXp: 20 });
    const log = (await dir.get(`/clubs/${club.id}/audit`)).body.entries;
    expect(log.map((e: { action: string }) => e.action)).toContain('requirement.approve');
    expect((await kid.get(`/clubs/${club.id}/audit`)).status).toBe(403);
  });
});
