import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clubs, subscriptions, users } from '../src/db/schema.js';
import { client, newUser, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx?.close(); });
const app = () => ctx.app;

const CPF = '529.982.247-25';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

async function platformAdmin() {
  const a = await newUser(app(), { name: 'Dona da Plataforma' });
  await ctx.db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, a.user.id));
  return a;
}

async function newClub(name = 'Clube Órion') {
  const owner = await newUser(app(), { name: 'Rafa Admin' });
  const res = await owner.post('/clubs', { name });
  const club = res.body.club;
  const code = (await owner.get(`/clubs/${club.id}`)).body.club.joinCode;
  return { owner, club, code, created: res.body };
}

async function addLeader(club: { id: string }, code: string, owner: Awaited<ReturnType<typeof newUser>>, role = 'diretor') {
  const p = await newUser(app());
  const m = (await p.post('/clubs/join', { code, role: role === 'diretor' ? 'associado' : role })).body.membership;
  await owner.post(`/clubs/${club.id}/members/${m.id}/approve`);
  if (role === 'diretor') await owner.patch(`/clubs/${club.id}/members/${m.id}`, { role: 'diretor' });
  return { ...p, m };
}

function upload(token: string, clubId: string, body: Buffer, type: string) {
  return app().inject({ method: 'PUT', url: `/api/clubs/${clubId}/logo`, payload: body, headers: { authorization: `Bearer ${token}`, 'content-type': type } });
}

describe('cadastro de pessoas', () => {
  it('guarda telefone, cidade, UF e responsável', async () => {
    const res = await client(app()).post('/auth/register', {
      username: 'joao.pedro', name: 'João Pedro', password: 'senha-forte-123', birth: '2013-05-02',
      phone: '(11) 98765-4321', city: 'Campinas', state: 'sp', guardianName: 'Marta', guardianPhone: '11 91234-5678',
    });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ phone: '11987654321', state: 'SP', guardianPhone: '11912345678' });
    const bad = await client(app()).post('/auth/register', { username: 'tel.ruim', name: 'X Y', password: 'senha-forte-123', phone: '123' });
    expect(bad.status).toBe(400);
    const uf = await client(app()).post('/auth/register', { username: 'uf.ruim', name: 'X Y', password: 'senha-forte-123', state: 'XX' });
    expect(uf.status).toBe(400);
  });

  it('liderança vê o contato do responsável; desbravador não', async () => {
    const { owner, club, code } = await newClub();
    const kid = await newUser(app());
    await kid.patch('/auth/me', { guardianName: 'Carla', guardianPhone: '21999998888' });
    await kid.post('/clubs/join', { code });
    const full = (await owner.get(`/clubs/${club.id}/members`)).body.members;
    expect(full.find((m: { name: string }) => m.name === kid.user.name)).toMatchObject({ guardianPhone: '21999998888' });
    const lite = (await kid.get(`/clubs/${club.id}/members`)).body.members;
    expect(lite[0]).not.toHaveProperty('guardianPhone');
  });

  it('diretoria corrige o cadastro de quem é só do clube', async () => {
    const { owner, club } = await newClub();
    const m = (await owner.post(`/clubs/${club.id}/members`, {
      username: 'kid.cadastro', name: 'Kid Cadastro', password: 'senha-forte-123', role: 'desbravador', guardianName: 'Pai',
    })).body.member;
    const r = await owner.patch(`/clubs/${club.id}/members/${m.id}/profile`, { guardianPhone: '31988887777', city: 'BH' });
    expect(r.body.member).toMatchObject({ guardianName: 'Pai', guardianPhone: '31988887777', city: 'BH' });
  });
});

describe('administrador do clube', () => {
  it('quem cria é o administrador e pode passar para outra pessoa da liderança', async () => {
    const { owner, club, code } = await newClub();
    expect((await owner.get(`/clubs/${club.id}`)).body.isAdmin).toBe(true);
    expect((await owner.get('/auth/me')).body.clubs[0].isAdmin).toBe(true);

    const kid = await newUser(app());
    const kidM = (await kid.post('/clubs/join', { code })).body.membership;
    expect((await owner.post(`/clubs/${club.id}/transfer`, { memberId: kidM.id })).status).toBe(400);

    const next = await addLeader(club, code, owner);
    // um diretor comum não mexe em cores nem transfere
    expect((await next.patch(`/clubs/${club.id}/theme`, { primary: '#123456' })).status).toBe(403);
    expect((await next.post(`/clubs/${club.id}/transfer`, { memberId: next.m.id })).status).toBe(403);

    const t = await owner.post(`/clubs/${club.id}/transfer`, { memberId: next.m.id });
    expect(t.body.admin.id).toBe(next.user.id);
    expect((await next.get(`/clubs/${club.id}`)).body.isAdmin).toBe(true);
    expect((await next.patch(`/clubs/${club.id}/theme`, { primary: '#123456' })).status).toBe(200);
    // o antigo administrador continua como diretor, mas perdeu os poderes exclusivos
    expect((await owner.patch(`/clubs/${club.id}/theme`, { primary: '#654321' })).status).toBe(403);
    expect((await owner.post(`/clubs/${club.id}/leave`)).status).toBe(204);
  });

  it('ninguém mexe no vínculo do administrador', async () => {
    const { owner, club, code } = await newClub();
    const dir = await addLeader(club, code, owner);
    const ownerM = (await owner.get(`/clubs/${club.id}`)).body.membership;
    expect((await dir.patch(`/clubs/${club.id}/members/${ownerM.id}`, { role: 'conselheiro' })).status).toBe(403);
    expect((await dir.del(`/clubs/${club.id}/members/${ownerM.id}`)).status).toBe(403);
    expect((await dir.del(`/clubs/${club.id}`, { confirm: club.name })).status).toBe(403);
  });
});

describe('cores e logo do clube', () => {
  it('personaliza cores, avisa contraste ruim e publica o CSS', async () => {
    const { owner, club } = await newClub('Clube Cores');
    const r = await owner.patch(`/clubs/${club.id}/theme`, { primary: '#0a3d91', onPrimary: '#ffffff', text: '#EEEEEE' });
    expect(r.status).toBe(200);
    expect(r.body.customTheme).toEqual({ primary: '#0A3D91', onPrimary: '#FFFFFF', text: '#EEEEEE' });
    expect(r.body.theme.background).toBe('#EDF0E7'); // o que não mudou fica no padrão
    expect(r.body.warnings.map((w: { foreground: string }) => w.foreground)).toContain('text');
    expect((await owner.patch(`/clubs/${club.id}/theme`, { primary: 'azul' })).status).toBe(400);
    expect((await owner.patch(`/clubs/${club.id}/theme`, { fonte: '#000000' })).status).toBe(400);

    const back = await owner.patch(`/clubs/${club.id}/theme`, { text: null });
    expect(back.body.customTheme).not.toHaveProperty('text');

    const css = await app().inject({ method: 'GET', url: `/api/clubs/${club.id}/theme.css` });
    expect(css.headers['content-type']).toContain('text/css');
    expect(css.body).toContain('--pine:#0A3D91');

    const pub = await client(app()).get(`/public/clubs/${club.slug}`);
    expect(pub.body.branding.theme.primary).toBe('#0A3D91');
  });

  it('envia, serve e remove o logo', async () => {
    const { owner, club, code } = await newClub('Clube Logo');
    const up = await upload(owner.token, club.id, PNG, 'image/png');
    expect(up.statusCode).toBe(200);
    const url = up.json().logoUrl as string;
    expect(url).toMatch(/\/logo\?v=/);

    const got = await app().inject({ method: 'GET', url });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(got.rawPayload, PNG)).toBe(0);
    const cached = await app().inject({ method: 'GET', url, headers: { 'if-none-match': got.headers.etag as string } });
    expect(cached.statusCode).toBe(304);
    expect((await owner.get(`/clubs/${club.id}`)).body.branding.logoUrl).toBe(url);

    // SVG não é aceito; tipo declarado precisa bater com o arquivo; só o administrador envia
    expect((await upload(owner.token, club.id, Buffer.from('<svg></svg>'), 'image/svg+xml')).statusCode).toBe(415);
    expect((await upload(owner.token, club.id, PNG, 'image/jpeg')).statusCode).toBe(400);
    const dir = await addLeader(club, code, owner);
    expect((await upload(dir.token, club.id, PNG, 'image/png')).statusCode).toBe(403);
    const big = Buffer.concat([PNG, Buffer.alloc(1100 * 1024)]);
    expect((await upload(owner.token, club.id, big, 'image/png')).statusCode).toBe(413);

    expect((await owner.del(`/clubs/${club.id}/logo`)).status).toBe(204);
    expect((await app().inject({ method: 'GET', url })).statusCode).toBe(404);
  });
});

describe('assinatura', () => {
  it('já vem com os planos mensal (R$ 13,49) e anual (R$ 119,99)', async () => {
    const list = (await client(app()).get('/plans')).body.plans;
    expect(list).toEqual([
      expect.objectContaining({ code: 'mensal', interval: 'mensal', priceCents: 1349, currency: 'BRL', maxMembers: null }),
      expect.objectContaining({ code: 'anual', interval: 'anual', priceCents: 11999, currency: 'BRL', maxMembers: null }),
    ]);
  });

  it('clube novo começa em teste; clube escolhe o plano e paga', async () => {
    const admin = await platformAdmin();
    const plans = (await client(app()).get('/plans')).body.plans;
    const mensal = plans.find((p: { code: string }) => p.code === 'mensal');
    const anual = plans.find((p: { code: string }) => p.code === 'anual');

    const { owner, club, created, code } = await newClub('Clube Pagante');
    expect(created.subscription).toMatchObject({ state: 'trial', active: true });

    // só o administrador do clube vê e mexe na assinatura
    const dir = await addLeader(club, code, owner);
    expect((await dir.get(`/clubs/${club.id}/subscription`)).status).toBe(403);

    const badDoc = await owner.post(`/clubs/${club.id}/subscription`, { planId: anual.id, billingName: 'Clube', billingDocument: '111.111.111-11', billingEmail: 'a@b.com' });
    expect(badDoc.status).toBe(400);
    const co = await owner.post(`/clubs/${club.id}/subscription`, { planId: anual.id, billingName: 'Igreja Central', billingDocument: CPF, billingEmail: 'tesouraria@igreja.org' });
    expect(co.status).toBe(201);
    expect(co.body.invoice).toMatchObject({ status: 'pendente', amountCents: 11999 });

    // trocar de plano cancela a fatura anterior
    const co2 = await owner.post(`/clubs/${club.id}/subscription`, { planId: mensal.id, billingName: 'Igreja Central', billingDocument: CPF, billingEmail: 'tesouraria@igreja.org' });
    const pend = (await admin.get('/admin/invoices?status=pendente')).body.invoices.filter((i: { club: { id: string } }) => i.club.id === club.id);
    expect(pend).toHaveLength(1);

    const paid = await admin.post(`/admin/invoices/${co2.body.invoice.id}/paid`, { reference: 'PIX 123' });
    expect(paid.body.invoice.status).toBe('paga');
    const sub = (await owner.get(`/clubs/${club.id}/subscription`)).body;
    expect(sub.subscription).toMatchObject({ status: 'ativa', state: 'ativa', active: true, billingDocument: '52998224725' });
    expect(sub.plan.code).toBe('mensal');
    const days = (new Date(sub.subscription.currentPeriodEnd).getTime() - Date.now()) / 864e5;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
    expect(paid.body.invoice.amountCents).toBe(1349);

    const cancel = await owner.post(`/clubs/${club.id}/subscription/cancel`);
    expect(cancel.body.subscription).toMatchObject({ state: 'cancelada', active: true });
  });

  it('com a assinatura vencida o clube fica só para leitura', async () => {
    const { owner, club, code } = await newClub('Clube Vencido');
    await ctx.db.update(subscriptions).set({ trialEndsAt: new Date(Date.now() - 864e5) }).where(eq(subscriptions.clubId, club.id));

    expect((await owner.get(`/clubs/${club.id}`)).body.subscription).toMatchObject({ state: 'expirada', active: false });
    expect((await owner.get(`/clubs/${club.id}/members`)).status).toBe(200);
    const w = await owner.post(`/clubs/${club.id}/units`, { name: 'Nova' });
    expect(w.status).toBe(402);
    expect(w.body.error).toBe('subscription_inactive');
    const joiner = await newUser(app());
    expect((await joiner.post('/clubs/join', { code })).status).toBe(402);
    // mas o administrador consegue renovar
    const admin = await platformAdmin();
    const plan = (await admin.post('/admin/plans', { code: 'mensal-2', name: 'Mensal', interval: 'mensal', priceCents: 1990 })).body.plan;
    const co = await owner.post(`/clubs/${club.id}/subscription`, { planId: plan.id, billingName: 'X Y', billingDocument: '11.222.333/0001-81', billingEmail: 'x@y.com' });
    expect(co.status).toBe(201);
    await admin.post(`/admin/invoices/${co.body.invoice.id}/paid`);
    expect((await owner.post(`/clubs/${club.id}/units`, { name: 'Nova' })).status).toBe(201);
  });

  it('respeita o limite de membros do plano', async () => {
    const admin = await platformAdmin();
    const plan = (await admin.post('/admin/plans', { code: 'mini', name: 'Mini', interval: 'mensal', priceCents: 990, maxMembers: 2 })).body.plan;
    const { owner, club, code } = await newClub('Clube Mini');
    const co = await owner.post(`/clubs/${club.id}/subscription`, { planId: plan.id, billingName: 'X Y', billingDocument: CPF, billingEmail: 'x@y.com' });
    await admin.post(`/admin/invoices/${co.body.invoice.id}/paid`);
    const a = await newUser(app());
    expect((await a.post('/clubs/join', { code })).status).toBe(201);
    const b = await newUser(app());
    expect((await b.post('/clubs/join', { code })).status).toBe(402);
  });

  it('plataforma dá dias de cortesia: teste para quem não paga, período para quem paga', async () => {
    const admin = await platformAdmin();
    const { owner, club } = await newClub('Clube Cortesia');
    await ctx.db.update(subscriptions).set({ trialEndsAt: new Date(Date.now() - 864e5) }).where(eq(subscriptions.clubId, club.id));
    const r = await admin.post(`/admin/clubs/${club.id}/subscription/extend`, { days: 30 });
    expect(r.body.subscription).toMatchObject({ state: 'trial', active: true });
    const left = (new Date(r.body.subscription.trialEndsAt).getTime() - Date.now()) / 864e5;
    expect(left).toBeGreaterThan(29.9);
    expect(left).toBeLessThan(30.1);

    const plan = (await client(app()).get('/plans')).body.plans[0];
    const co = await owner.post(`/clubs/${club.id}/subscription`, { planId: plan.id, billingName: 'X Y', billingDocument: CPF, billingEmail: 'x@y.com' });
    await admin.post(`/admin/invoices/${co.body.invoice.id}/paid`);
    const before = (await owner.get(`/clubs/${club.id}/subscription`)).body.subscription.currentPeriodEnd;
    const r2 = await admin.post(`/admin/clubs/${club.id}/subscription/extend`, { days: 10 });
    expect(r2.body.subscription.state).toBe('ativa');
    expect(new Date(r2.body.subscription.currentPeriodEnd).getTime() - new Date(before).getTime()).toBe(10 * 864e5);
    expect((await owner.post(`/admin/clubs/${club.id}/subscription/extend`, { days: 10 })).status).toBe(403);
  });

  it('só a plataforma cria planos e vê todos os clubes', async () => {
    const { owner } = await newClub('Clube Qualquer');
    expect((await owner.post('/admin/plans', { code: 'x', name: 'X', interval: 'mensal', priceCents: 1 })).status).toBe(403);
    const admin = await platformAdmin();
    const all = (await admin.get('/admin/clubs')).body.clubs;
    const [row] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(clubs);
    expect(all).toHaveLength(row.n);
    expect(all[0]).toHaveProperty('admin.name');
    expect(all[0]).toHaveProperty('subscription.state');
  });
});
