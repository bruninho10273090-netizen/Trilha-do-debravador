/* Servidor simulado do Trilha: responde às chamadas /api dentro do próprio navegador,
   seguindo as regras do backend real (contas, clubes, funções, assinatura, aprovações).
   Serve para navegar e testar sem servidor. Tudo fica no localStorage de quem abre.
   O catálogo (window.__TRILHA_CAT__) é embutido pelo build. */
(function () {
  'use strict';
  window.__TRILHA_SIM__ = true;
  const KEY = 'trilha-sim.v1';
  const ADMIN_CODE = 'TRILHA-SIMULACAO';
  const CAT = window.__TRILHA_CAT__ || { items: {}, espRefs: {}, espReqs: {} };
  const DAY = 864e5;
  const now = () => new Date().toISOString();
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Math.random().toString(36).slice(2) + Date.now().toString(36));
  const rnd = (n, abc) => Array.from({ length: n }, () => abc[Math.floor(Math.random() * abc.length)]).join('');

  function fresh() {
    const t = now();
    return {
      users: [], sessions: {}, clubs: [], memberships: [], units: [], reqs: [], esps: [], logos: {}, subs: [], invoices: [],
      plans: [
        { id: uid(), code: 'mensal', name: 'Mensal', interval: 'mensal', priceCents: 1349, currency: 'BRL', maxMembers: null, active: true, createdAt: t },
        { id: uid(), code: 'anual', name: 'Anual', interval: 'anual', priceCents: 11999, currency: 'BRL', maxMembers: null, active: true, createdAt: t },
      ],
    };
  }
  let S;
  try { S = JSON.parse(localStorage.getItem(KEY)) || fresh(); } catch (e) { S = fresh(); }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* cheio ou bloqueado: segue na memória */ } };
  window.__TRILHA_SIM_RESET__ = () => { try { localStorage.removeItem(KEY); localStorage.removeItem('trilha-dbv.api.token'); localStorage.removeItem('trilha-dbv.api.club'); } catch (e) {} location.reload(); };

  class E extends Error { constructor(status, code, msg) { super(msg); this.status = status; this.code = code; } }
  const bad = (m) => new E(400, 'bad_request', m);
  const unauth = (m) => new E(401, 'unauthorized', m || 'Faça login para continuar.');
  const forbid = (m) => new E(403, 'forbidden', m || 'Você não tem permissão para isso.');
  const nf = (m) => new E(404, 'not_found', m || 'Não encontrado.');
  const conflict = (m) => new E(409, 'conflict', m);
  const payReq = (m) => new E(402, 'subscription_inactive', m);

  async function hash(pw) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('trilha-sim|' + pw));
    return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');
  function profile(b, into) {
    for (const k of ['phone', 'guardianPhone']) if (k in b) {
      if (b[k] == null || b[k] === '') into[k] = null;
      else { const d = digits(b[k]); if (d.length < 10 || d.length > 13) throw bad('Telefone inválido. Informe DDD e número.'); into[k] = d; }
    }
    for (const k of ['city', 'guardianName']) if (k in b) into[k] = b[k] ? String(b[k]).trim().slice(0, 80) : null;
    if ('state' in b) { const u = b.state ? String(b.state).toUpperCase() : null; if (u && !UFS.includes(u)) throw bad('UF inválida.'); into.state = u; }
    if ('birth' in b) into.birth = b.birth || null;
    if ('email' in b) {
      const e = b.email ? String(b.email).trim().toLowerCase() : null;
      if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw bad('E-mail inválido.');
      if (e && S.users.some((u) => u.email === e && u.id !== into.id)) throw conflict('Esse e-mail já está em uso.');
      into.email = e;
    }
    if ('name' in b && b.name) { const n = String(b.name).trim(); if (n.length < 2) throw bad('Informe o nome.'); into.name = n.slice(0, 80); }
    return into;
  }
  const validUser = (u) => /^[a-z0-9._-]{3,24}$/.test(u) && !/^\.+$/.test(u);
  const pubUser = (u) => ({ id: u.id, username: u.username, name: u.name, email: u.email || null, birth: u.birth || null, phone: u.phone || null, city: u.city || null, state: u.state || null, guardianName: u.guardianName || null, guardianPhone: u.guardianPhone || null, isPlatformAdmin: !!u.isPlatformAdmin, disabledAt: u.disabledAt || null, createdAt: u.createdAt });
  const userBy = (id) => S.users.find((u) => u.id === id);
  const clubBy = (id) => S.clubs.find((c) => c.id === id);
  const subOf = (clubId) => S.subs.find((s) => s.clubId === clubId);
  const planBy = (id) => S.plans.find((p) => p.id === id);

  function subState(s) {
    if (!s) return { state: 'expirada', active: false, endsAt: null };
    const t = Date.now();
    if (s.status === 'trial') { const e = s.trialEndsAt && Date.parse(s.trialEndsAt); return e > t ? { state: 'trial', active: true, endsAt: s.trialEndsAt } : { state: 'expirada', active: false, endsAt: s.trialEndsAt }; }
    const e = s.currentPeriodEnd && Date.parse(s.currentPeriodEnd);
    if (!e) return { state: 'expirada', active: false, endsAt: null };
    const canc = s.status === 'cancelada' || s.cancelAtPeriodEnd;
    if (e > t) return { state: canc ? 'cancelada' : 'ativa', active: true, endsAt: s.currentPeriodEnd };
    if (!canc && e + 5 * DAY > t) return { state: 'em_atraso', active: true, endsAt: s.currentPeriodEnd };
    return { state: canc ? 'cancelada' : 'expirada', active: false, endsAt: s.currentPeriodEnd };
  }
  const periodEnd = (start, plan) => { const d = new Date(start); if (plan.interval === 'anual') d.setUTCFullYear(d.getUTCFullYear() + 1); else d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString(); };
  const logoUrl = (clubId) => S.logos[clubId] || null;
  const resolveTheme = (c) => Object.assign({ background: '#EDF0E7', surface: '#FAFBF6', surfaceAlt: '#E3E8DA', text: '#15231B', muted: '#56655B', border: '#D1D8C8', primary: '#1F5A3C', onPrimary: '#F4F8F2', header: '#173F2B', onHeader: '#EAF2EC', accent: '#B8820C', accentSoft: '#F5E6BD', onAccentSoft: '#583C00' }, c || {});
  const branding = (c) => ({ theme: resolveTheme(c.theme), customTheme: c.theme || {}, logoUrl: logoUrl(c.id) });

  /* ---------- permissões (iguais às do backend) ---------- */
  const ROLES = ['diretor', 'associado', 'conselheiro', 'instrutor', 'desbravador'];
  const LEAD = ['diretor', 'associado', 'conselheiro', 'instrutor'], ADM = ['diretor', 'associado'];
  const PERMS = { view: ROLES, update: ADM, joinCode: ADM, units: ADM, viewAll: LEAD, manage: ADM, review: LEAD, owner: [] };
  const active = (m) => !!m && m.status === 'ativo';
  const isOwner = (x) => active(x.m) && x.club.ownerId === x.user.id;
  const can = (x, p) => x.user.isPlatformAdmin || isOwner(x) || (active(x.m) && PERMS[p].includes(x.m.role));
  function canManage(x, t, newRole) {
    if (!can(x, 'manage')) return false;
    if (x.user.isPlatformAdmin || isOwner(x)) return true;
    if (t.userId === x.club.ownerId) return false;
    if (t.id === x.m.id && newRole && newRole !== x.m.role) return false;
    if (x.m.role === 'associado' && (t.role === 'diretor' || newRole === 'diretor')) return false;
    return true;
  }
  function canReview(x, t) {
    if (!can(x, 'review')) return false;
    if (x.user.isPlatformAdmin) return true;
    if (t.id === x.m.id) return false;
    return true;
  }
  const canCard = (x, t) => (active(x.m) && x.m.id === t.id) || canReview(x, t);
  const canBook = (x, t) => active(x.m) && x.m.id === t.id;

  /* ---------- contexto da requisição ---------- */
  function me(req) { const id = S.sessions[req.token]; const u = id && userBy(id); if (!u || u.disabledAt) throw unauth(); return u; }
  function ctx(req, clubId, perm, allowInactive) {
    const user = me(req); const club = clubBy(clubId); if (!club) throw nf('Clube não encontrado.');
    const m = S.memberships.find((x) => x.clubId === club.id && x.userId === user.id) || null;
    const x = { user, club, m };
    if (!can(x, 'view')) throw nf('Clube não encontrado.');
    if (perm && !can(x, perm)) throw forbid();
    if (req.method !== 'GET' && !allowInactive && !user.isPlatformAdmin && !subState(subOf(club.id)).active) throw payReq('A assinatura do clube venceu. O administrador precisa renová-la para voltar a salvar.');
    return x;
  }
  function member(club, id) { const m = S.memberships.find((x) => x.id === id && x.clubId === club.id); if (!m) throw nf('Membro não encontrado.'); return m; }
  const memberView = (m, u, ownerId) => ({ id: m.id, clubId: m.clubId, userId: u.id, username: u.username, name: u.name, birth: u.birth || null, email: u.email || null, phone: u.phone || null, city: u.city || null, state: u.state || null, guardianName: u.guardianName || null, guardianPhone: u.guardianPhone || null, role: m.role, status: m.status, unitId: m.unitId || null, classId: m.classId || null, isAdmin: u.id === ownerId, createdAt: m.createdAt });
  function classFor(birth) {
    if (!birth) return 'amigo';
    const d = new Date(birth + 'T12:00:00'); if (isNaN(d)) return 'amigo';
    const n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) a--;
    return CLASS_IDS[Math.max(0, Math.min(5, a - 10))];
  }
  const CLASS_IDS = ['amigo', 'companheiro', 'pesquisador', 'pioneiro', 'excursionista', 'guia'];
  /* Requisito de classe que o desbravador ainda não alcançou: fica bloqueado. */
  const ahead = (t, it) => { const cur = t.classId && CLASS_IDS.includes(t.classId) ? t.classId : classFor(userBy(t.userId).birth);
    if (CLASS_IDS.indexOf(it.c) > CLASS_IDS.indexOf(cur)) throw forbid('Essa classe ainda não está liberada para este desbravador.'); return it; };
  const seatFree = (clubId) => {
    const s = subOf(clubId); if (!s || !s.planId || s.status === 'trial') return;
    const p = planBy(s.planId); if (!p || !p.maxMembers) return;
    if (S.memberships.filter((m) => m.clubId === clubId && m.status !== 'inativo').length >= p.maxMembers) throw payReq('O plano do clube permite até ' + p.maxMembers + ' membros.');
  };

  /* ---------- progresso ---------- */
  const reqRow = (mid, key) => S.reqs.find((r) => r.membershipId === mid && r.itemKey === key);
  function upReq(mid, key, set, by) {
    let r = reqRow(mid, key);
    if (!r) { r = { membershipId: mid, itemKey: key, status: null, note: null, choice: null, subs: null, comment: null, submittedAt: null, reviewedBy: null, reviewedAt: null }; S.reqs.push(r); }
    Object.assign(r, set, { updatedBy: by, updatedAt: now() }); return r;
  }
  const espRow = (mid, id) => S.esps.find((r) => r.membershipId === mid && r.specialtyId === id);
  function upEsp(mid, id, set) {
    let r = espRow(mid, id);
    if (!r) { r = { membershipId: mid, specialtyId: id, status: null, customName: null, customArea: null, answers: {}, done: [], comment: null, submittedAt: null, reviewedBy: null, reviewedAt: null }; S.esps.push(r); }
    Object.assign(r, set, { updatedAt: now() }); return r;
  }
  const item = (key) => { const it = CAT.items[key]; if (!it) throw nf('Requisito não existe no cartão.'); return it; };
  const espOk = (id) => { if (!CAT.espReqs[id] && !/^custom-[a-z0-9-]{1,60}$/.test(id)) throw nf('Especialidade não existe no caderno.'); };

  /* ---------- rotas ---------- */
  const R = [];
  const on = (method, path, fn) => R.push({ method, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

  on('GET', '/health', () => ({ ok: true }));

  // conta
  on('POST', '/auth/register', async (req) => {
    const b = req.body || {}; const username = String(b.username || '').trim().toLowerCase();
    if (!validUser(username)) throw bad('Use de 3 a 24 letras, números, ponto, hífen ou sublinhado.');
    if (String(b.password || '').length < 8) throw bad('A senha precisa de pelo menos 8 caracteres.');
    if (S.users.some((u) => u.username === username)) throw conflict('Esse usuário ou e-mail já está em uso.');
    const u = profile(b, { id: uid(), username, name: '', createdAt: now() });
    if (!u.name) throw bad('Informe o nome.');
    u.passwordHash = await hash(b.password); S.users.push(u);
    const token = uid(); S.sessions[token] = u.id; save();
    return [201, { token, user: pubUser(u) }];
  });
  on('POST', '/auth/login', async (req) => {
    const b = req.body || {}; const id = String(b.username || '').trim().toLowerCase();
    const u = S.users.find((x) => x.username === id || (x.email && x.email === id));
    if (!u || u.disabledAt || u.passwordHash !== (await hash(String(b.password || '')))) throw unauth('Usuário ou senha incorretos.');
    const token = uid(); S.sessions[token] = u.id; save();
    return { token, user: pubUser(u) };
  });
  on('POST', '/auth/logout', (req) => { delete S.sessions[req.token]; save(); return [204]; });
  on('GET', '/auth/me', (req) => {
    const u = me(req);
    const clubs = S.memberships.filter((m) => m.userId === u.id).map((m) => { const c = clubBy(m.clubId); return { membershipId: m.id, role: m.role, status: m.status, unitId: m.unitId, classId: m.classId, isAdmin: c.ownerId === u.id, club: { id: c.id, name: c.name, slug: c.slug, logoUrl: logoUrl(c.id) } }; })
      .sort((a, b) => a.club.name.localeCompare(b.club.name, 'pt-BR'));
    return { user: pubUser(u), clubs };
  });
  on('PATCH', '/auth/me', (req) => { const u = me(req); profile(req.body || {}, u); save(); return { user: pubUser(u) }; });
  on('POST', '/auth/password', async (req) => {
    const u = me(req); const b = req.body || {};
    if (u.passwordHash !== (await hash(String(b.current || '')))) throw bad('A senha atual não confere.');
    if (String(b.password || '').length < 8) throw bad('A senha precisa de pelo menos 8 caracteres.');
    u.passwordHash = await hash(b.password);
    for (const t of Object.keys(S.sessions)) if (S.sessions[t] === u.id && t !== req.token) delete S.sessions[t];
    save(); return [204];
  });
  on('POST', '/auth/claim-admin', (req) => {
    const u = me(req); if (String((req.body || {}).code || '').trim() !== ADMIN_CODE) throw forbid('Código incorreto.');
    u.isPlatformAdmin = true; save(); return { user: pubUser(u) };
  });

  // clubes
  on('POST', '/clubs', (req) => {
    const u = me(req); const name = String((req.body || {}).name || '').trim();
    if (name.length < 2) throw bad('Informe o nome do clube.');
    const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'clube';
    let slug = base; while (S.clubs.some((c) => c.slug === slug)) slug = base + '-' + Math.floor(1000 + Math.random() * 9000);
    const club = { id: uid(), name: name.slice(0, 80), slug, joinCode: rnd(8, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'), church: (req.body || {}).church || null, region: (req.body || {}).region || null, settings: { autoApproveDesbravadores: true, counselorScope: 'club' }, theme: {}, ownerId: u.id, createdAt: now() };
    S.clubs.push(club);
    const m = { id: uid(), clubId: club.id, userId: u.id, role: 'diretor', status: 'ativo', unitId: null, classId: null, createdAt: now() };
    S.memberships.push(m);
    const sub = { id: uid(), clubId: club.id, planId: null, status: 'trial', trialEndsAt: new Date(Date.now() + 14 * DAY).toISOString(), currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, billingName: null, billingDocument: null, billingEmail: null };
    S.subs.push(sub); save();
    return [201, { club, membership: m, subscription: Object.assign({}, sub, subState(sub)) }];
  });
  on('POST', '/clubs/join', (req) => {
    const u = me(req); const b = req.body || {}; const code = String(b.code || '').trim().toUpperCase();
    const club = S.clubs.find((c) => c.joinCode === code); if (!club) throw nf('Código de clube não encontrado.');
    if (!subState(subOf(club.id)).active) throw payReq('A assinatura desse clube venceu.');
    seatFree(club.id);
    const role = ['desbravador', 'conselheiro', 'instrutor', 'associado'].includes(b.role) ? b.role : 'desbravador';
    if (S.memberships.some((m) => m.clubId === club.id && m.userId === u.id)) throw conflict('Você já faz parte deste clube.');
    const kid = role === 'desbravador';
    const m = { id: uid(), clubId: club.id, userId: u.id, role, status: kid ? 'ativo' : 'pendente', unitId: b.unitId || null, classId: kid ? classFor(u.birth) : null, createdAt: now() };
    S.memberships.push(m); save();
    return [201, { membership: m, club: { id: club.id, name: club.name, slug: club.slug } }];
  });
  on('POST', '/clubs/import', () => { throw bad('Na simulação a importação não está disponível. Ela funciona no servidor oficial.'); });
  on('GET', '/clubs/:id', (req, p) => {
    const x = ctx(req, p.id); const c = x.club; const o = userBy(c.ownerId);
    const club = Object.assign({}, c); delete club.theme; if (!can(x, 'joinCode')) delete club.joinCode;
    return { club, admin: { id: o.id, name: o.name, username: o.username }, isAdmin: isOwner(x), subscription: subState(subOf(c.id)), branding: branding(c), units: S.units.filter((un) => un.clubId === c.id).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')), membership: x.m };
  });
  on('PATCH', '/clubs/:id', (req, p) => { const x = ctx(req, p.id, 'update'); const b = req.body || {}; if (b.name) x.club.name = String(b.name).trim().slice(0, 80); save(); return { club: x.club }; });
  on('POST', '/clubs/:id/join-code', (req, p) => { const x = ctx(req, p.id, 'joinCode'); x.club.joinCode = rnd(8, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'); save(); return { joinCode: x.club.joinCode }; });
  on('POST', '/clubs/:id/transfer', (req, p) => {
    const x = ctx(req, p.id, 'owner', true); const t = member(x.club, (req.body || {}).memberId); const u = userBy(t.userId);
    if (u.id === x.club.ownerId) throw bad('Essa pessoa já é a administradora do clube.');
    if (t.status !== 'ativo' || !LEAD.includes(t.role)) throw bad('A administração só pode ir para alguém ativo da liderança.');
    x.club.ownerId = u.id; save(); return { admin: { id: u.id, name: u.name, username: u.username } };
  });
  on('POST', '/clubs/:id/units', (req, p) => {
    const x = ctx(req, p.id, 'units'); const name = String((req.body || {}).name || '').trim().slice(0, 40); if (!name) throw bad('Informe o nome.');
    if (S.units.some((u) => u.clubId === x.club.id && u.name.toLowerCase() === name.toLowerCase())) throw conflict('Já existe uma unidade com esse nome.');
    const un = { id: uid(), clubId: x.club.id, name, color: (req.body || {}).color || null }; S.units.push(un); save(); return [201, { unit: un }];
  });
  on('PATCH', '/clubs/:id/units/:u', (req, p) => { const x = ctx(req, p.id, 'units'); const un = S.units.find((u) => u.id === p.u && u.clubId === x.club.id); if (!un) throw nf('Unidade não encontrada.'); if ((req.body || {}).name) un.name = String(req.body.name).trim().slice(0, 40); save(); return { unit: un }; });
  on('DELETE', '/clubs/:id/units/:u', (req, p) => { const x = ctx(req, p.id, 'units'); S.units = S.units.filter((u) => !(u.id === p.u && u.clubId === x.club.id)); S.memberships.forEach((m) => { if (m.unitId === p.u) m.unitId = null; }); save(); return [204]; });

  // membros
  on('GET', '/clubs/:id/members', (req, p) => {
    const x = ctx(req, p.id); const full = can(x, 'viewAll');
    const members = S.memberships.filter((m) => m.clubId === x.club.id && (full || m.status === 'ativo')).map((m) => { const u = userBy(m.userId); return full ? memberView(m, u, x.club.ownerId) : { id: m.id, userId: u.id, name: u.name, username: u.username, role: m.role, status: m.status, unitId: m.unitId || null, classId: m.classId || null }; });
    return { members };
  });
  on('POST', '/clubs/:id/members', async (req, p) => {
    const x = ctx(req, p.id, 'manage'); const b = req.body || {}; const username = String(b.username || '').trim().toLowerCase();
    if (!validUser(username)) throw bad('Usuário inválido.');
    if (S.users.some((u) => u.username === username)) throw conflict('Esse nome de usuário já existe. Se a pessoa já tem conta, envie o código do clube para ela entrar.');
    if (String(b.password || '').length < 8) throw bad('A senha precisa de pelo menos 8 caracteres.');
    const role = ROLES.includes(b.role) ? b.role : 'desbravador';
    if (!x.user.isPlatformAdmin && !isOwner(x) && x.m.role === 'associado' && role === 'diretor') throw forbid('Só o diretor pode cadastrar outro diretor.');
    seatFree(x.club.id);
    const u = profile(b, { id: uid(), username, name: '', createdAt: now() }); if (!u.name) throw bad('Informe o nome.');
    u.passwordHash = await hash(b.password); S.users.push(u);
    const m = { id: uid(), clubId: x.club.id, userId: u.id, role, status: 'ativo', unitId: b.unitId || null, classId: role === 'desbravador' ? (b.classId || classFor(u.birth)) : null, createdAt: now() };
    S.memberships.push(m); save(); return [201, { member: memberView(m, u, x.club.ownerId) }];
  });
  on('PATCH', '/clubs/:id/members/:m', (req, p) => {
    const x = ctx(req, p.id); const t = member(x.club, p.m); const b = req.body || {}; const self = x.m && x.m.id === t.id;
    const onlyUnit = Object.keys(b).every((k) => k === 'unitId');
    if (!(self && onlyUnit && !t.unitId && !can(x, 'manage')) && !canManage(x, t, b.role)) throw forbid();
    if (t.userId === x.club.ownerId && b.status === 'inativo') throw forbid('O administrador do clube não pode ficar inativo.');
    if (b.role && ROLES.includes(b.role)) t.role = b.role;
    if (b.status) t.status = b.status;
    if ('unitId' in b) t.unitId = b.unitId || null;
    if (t.role !== 'desbravador') t.classId = null; else if ('classId' in b) t.classId = b.classId; else if (!t.classId) t.classId = classFor(userBy(t.userId).birth);
    save(); return { member: memberView(t, userBy(t.userId), x.club.ownerId) };
  });
  const onlyHere = (userId, clubId, x) => { if (!x.user.isPlatformAdmin && S.memberships.some((m) => m.userId === userId && m.clubId !== clubId)) throw forbid('Essa pessoa participa de outros clubes; ela mesma precisa alterar esses dados.'); };
  on('PATCH', '/clubs/:id/members/:m/profile', (req, p) => { const x = ctx(req, p.id, 'manage'); const t = member(x.club, p.m); if (!canManage(x, t)) throw forbid(); const u = userBy(t.userId); if (u.id !== x.user.id) onlyHere(u.id, x.club.id, x); profile(req.body || {}, u); save(); return { member: memberView(t, u, x.club.ownerId) }; });
  on('POST', '/clubs/:id/members/:m/approve', (req, p) => { const x = ctx(req, p.id, 'manage'); const t = member(x.club, p.m); if (t.status !== 'pendente') throw bad('Essa conta não está pendente.'); t.status = 'ativo'; save(); return { member: memberView(t, userBy(t.userId), x.club.ownerId) }; });
  on('DELETE', '/clubs/:id/members/:m', (req, p) => {
    const x = ctx(req, p.id, 'manage'); const t = member(x.club, p.m);
    if (t.userId === x.club.ownerId) throw forbid('O administrador do clube não pode ser removido.');
    if (!canManage(x, t)) throw forbid();
    S.memberships = S.memberships.filter((m) => m.id !== t.id); S.reqs = S.reqs.filter((r) => r.membershipId !== t.id); S.esps = S.esps.filter((r) => r.membershipId !== t.id); save(); return [204];
  });
  on('POST', '/clubs/:id/members/:m/password', async (req, p) => {
    const x = ctx(req, p.id, 'manage'); const t = member(x.club, p.m); if (!canManage(x, t)) throw forbid();
    onlyHere(t.userId, x.club.id, x); if (String((req.body || {}).password || '').length < 8) throw bad('A senha precisa de pelo menos 8 caracteres.');
    const u = userBy(t.userId); u.passwordHash = await hash(req.body.password); for (const k of Object.keys(S.sessions)) if (S.sessions[k] === u.id) delete S.sessions[k]; save(); return [204];
  });

  // cartão e caderno
  on('GET', '/clubs/:id/progress', (req, p) => {
    const x = ctx(req, p.id); const full = can(x, 'viewAll'); const mine = x.m && x.m.id;
    const ids = new Set(S.memberships.filter((m) => m.clubId === x.club.id && m.role === 'desbravador' && m.status === 'ativo').map((m) => m.id));
    const open = (id) => full || id === mine;
    return {
      requirements: S.reqs.filter((r) => ids.has(r.membershipId)).map((r) => open(r.membershipId) ? r : { membershipId: r.membershipId, itemKey: r.itemKey, status: r.status, reviewedAt: r.reviewedAt, updatedAt: r.updatedAt }),
      specialties: S.esps.filter((s) => ids.has(s.membershipId) && s.status).map((s) => open(s.membershipId) ? s : { membershipId: s.membershipId, specialtyId: s.specialtyId, status: s.status, customName: s.customName, customArea: s.customArea, reviewedAt: s.reviewedAt, updatedAt: s.updatedAt }),
    };
  });
  const card = (req, p) => { const x = ctx(req, p.id); const t = member(x.club, p.m); if (t.role !== 'desbravador') throw bad('Só desbravadores têm cartão de classe.'); return [x, t]; };
  on('PATCH', '/clubs/:id/members/:m/requirements/:k', (req, p) => {
    const [x, t] = card(req, p); const it = ahead(t, item(decodeURIComponent(p.k))); if (!canCard(x, t)) throw forbid();
    const cur = reqRow(t.id, p.k); const b = req.body || {};
    if (cur && cur.status === 'aprovado') throw bad('Esse requisito já foi aprovado.');
    if (cur && cur.status === 'enviado' && x.m && x.m.id === t.id) throw bad('Cancele o envio para editar.');
    const set = {};
    if ('note' in b) set.note = b.note;
    if (b.choice) { if (!it.o || b.choice.length > (it.k || 1)) throw bad('Escolha até ' + (it.k || 1) + ' opção(ões).'); set.choice = b.choice; }
    if (b.subs) set.subs = b.subs;
    const r = upReq(t.id, p.k, set, x.user.id); save(); return { requirement: r };
  });
  on('POST', '/clubs/:id/members/:m/requirements/approve', (req, p) => {
    const [x, t] = card(req, p); if (!canReview(x, t)) throw forbid();
    ((req.body || {}).keys || []).forEach((k) => ahead(t, item(k)));
    const out = ((req.body || {}).keys || []).map((k) => {  return upReq(t.id, k, { status: 'aprovado', comment: null, reviewedBy: x.user.id, reviewedAt: now() }, x.user.id); });
    save(); return { requirements: out };
  });
  on('POST', '/clubs/:id/members/:m/requirements/:k/:act', (req, p) => {
    const [x, t] = card(req, p); const key = decodeURIComponent(p.k); const it = item(key); const cur = reqRow(t.id, key); let r;
    if (p.act === 'submit' || p.act === 'approve') ahead(t, it);
    if (p.act === 'submit') {
      if (!canCard(x, t)) throw forbid();
      if (cur && (cur.status === 'enviado' || cur.status === 'aprovado')) throw bad('Esse requisito já foi enviado.');
      if (it.o && !((cur && cur.choice) || []).length) throw bad('Escolha ' + ((it.k || 1) > 1 ? 'as ' + it.k + ' opções' : 'uma opção') + ' antes de enviar.');
      r = upReq(t.id, key, { status: 'enviado', comment: null, submittedAt: now() }, x.user.id);
    } else if (p.act === 'unsubmit') {
      if (!canCard(x, t)) throw forbid(); if (!cur || cur.status !== 'enviado') throw bad('Esse requisito não está aguardando aprovação.');
      r = upReq(t.id, key, { status: null, submittedAt: null }, x.user.id);
    } else if (p.act === 'approve') {
      if (!canReview(x, t)) throw forbid(); r = upReq(t.id, key, { status: 'aprovado', comment: null, reviewedBy: x.user.id, reviewedAt: now() }, x.user.id);
    } else if (p.act === 'return') {
      if (!canReview(x, t)) throw forbid(); if (!cur || cur.status !== 'enviado') throw bad('Só dá para devolver o que foi enviado.');
      r = upReq(t.id, key, { status: 'devolvido', comment: String((req.body || {}).comment || '').slice(0, 1000), reviewedBy: x.user.id, reviewedAt: now() }, x.user.id);
    } else if (p.act === 'unapprove') {
      if (!canReview(x, t)) throw forbid(); if (!cur || cur.status !== 'aprovado') throw bad('Esse requisito não está aprovado.');
      r = upReq(t.id, key, { status: null, reviewedBy: x.user.id, reviewedAt: now() }, x.user.id);
    } else throw nf();
    save(); return { requirement: r };
  });
  on('PATCH', '/clubs/:id/members/:m/specialties/:e', (req, p) => {
    const [x, t] = card(req, p); const id = decodeURIComponent(p.e); espOk(id); if (!canBook(x, t)) throw forbid('O caderno é pessoal: só o próprio desbravador escreve nele.');
    const cur = espRow(t.id, id); const b = req.body || {};
    if (cur && (cur.status === 'enviado' || cur.status === 'aprovado')) throw bad('Cancele o envio para editar.');
    if (!CAT.espReqs[id] && !cur && !b.customName) throw bad('Dê um nome para a especialidade.');
    const set = { status: (cur && cur.status) || 'andamento' };
    if (b.answers) set.answers = Object.assign({}, (cur && cur.answers) || {}, b.answers);
    if (b.done) set.done = b.done.slice().sort((a, c) => a - c);
    if (b.customName) set.customName = b.customName; if (b.customArea) set.customArea = b.customArea;
    const r = upEsp(t.id, id, set); save(); return { specialty: r };
  });
  on('DELETE', '/clubs/:id/members/:m/specialties/:e', (req, p) => {
    const [x, t] = card(req, p); const id = decodeURIComponent(p.e); if (!canBook(x, t)) throw forbid();
    const cur = espRow(t.id, id); if (!cur || !cur.status) throw nf('Essa especialidade não está no caderno.');
    if (cur.status === 'enviado' || cur.status === 'aprovado') throw bad('Só dá para tirar especialidades em andamento ou devolvidas.');
    cur.status = null; save(); return [204];
  });
  on('POST', '/clubs/:id/members/:m/specialties/:e/:act', (req, p) => {
    const [x, t] = card(req, p); const id = decodeURIComponent(p.e); espOk(id); const cur = espRow(t.id, id); let r; const out = {};
    if (p.act === 'submit') {
      if (!canBook(x, t)) throw forbid(); if (!cur || !(cur.status === 'andamento' || cur.status === 'devolvido')) throw bad('Essa especialidade não está em andamento.');
      const n = CAT.espReqs[id]; if (n && cur.done.length < n) throw bad('Marque todos os requisitos antes de enviar.');
      if (!n && !String((cur.answers || {}).r0 || '').trim()) throw bad('Escreva suas respostas antes de enviar.');
      r = upEsp(t.id, id, { status: 'enviado', comment: null, submittedAt: now() });
    } else if (p.act === 'unsubmit') {
      if (!canBook(x, t)) throw forbid(); if (!cur || cur.status !== 'enviado') throw bad('Essa especialidade não está aguardando aprovação.');
      r = upEsp(t.id, id, { status: 'andamento', submittedAt: null });
    } else if (p.act === 'approve') {
      if (!canReview(x, t)) throw forbid(); if (!cur || !cur.status) throw bad('Essa especialidade não está no caderno.');
      r = upEsp(t.id, id, { status: 'aprovado', comment: null, reviewedBy: x.user.id, reviewedAt: now() });
      out.linkedRequirements = (CAT.espRefs[id] || []).filter((l) => { const e = reqRow(t.id, l.key); return !e || e.status !== 'aprovado'; })
        .map((l) => upReq(t.id, l.key, Object.assign({ status: 'aprovado', comment: null, reviewedBy: x.user.id, reviewedAt: now() }, l.ix >= 0 ? { choice: [l.ix] } : {}), x.user.id));
    } else if (p.act === 'return') {
      if (!canReview(x, t)) throw forbid(); if (!cur || cur.status !== 'enviado') throw bad('Só dá para devolver o que foi enviado.');
      r = upEsp(t.id, id, { status: 'devolvido', comment: String((req.body || {}).comment || '').slice(0, 1000), reviewedBy: x.user.id, reviewedAt: now() });
    } else if (p.act === 'unapprove') {
      if (!canReview(x, t)) throw forbid(); if (!cur || cur.status !== 'aprovado') throw bad('Essa especialidade não está aprovada.');
      r = upEsp(t.id, id, { status: 'andamento', reviewedBy: x.user.id, reviewedAt: now() });
    } else throw nf();
    save(); return Object.assign({ specialty: r }, out);
  });

  // cores e logo
  on('GET', '/public/clubs/:slug', (req, p) => { const c = S.clubs.find((k) => k.slug === p.slug); if (!c) throw nf('Clube não encontrado.'); return { club: { id: c.id, name: c.name, slug: c.slug }, branding: branding(c) }; });
  on('PATCH', '/clubs/:id/theme', (req, p) => {
    const x = ctx(req, p.id, 'owner'); const next = Object.assign({}, x.club.theme || {});
    for (const [k, v] of Object.entries(req.body || {})) { if (v === null) delete next[k]; else if (/^#[0-9a-fA-F]{6}$/.test(v)) next[k] = v.toUpperCase(); else throw bad('Use uma cor no formato #RRGGBB.'); }
    x.club.theme = next; save(); return { theme: resolveTheme(next), customTheme: next, warnings: [] };
  });
  on('PUT', '/clubs/:id/logo', async (req, p) => {
    const x = ctx(req, p.id, 'owner'); const blob = req.rawBody;
    if (!(blob instanceof Blob) || !/^image\/(png|jpeg|webp)$/.test(blob.type)) throw bad('O arquivo precisa ser uma imagem PNG, JPEG ou WebP.');
    if (blob.size > 1024 * 1024) throw new E(413, 'too_large', 'Arquivo grande demais.');
    const url = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = no; fr.readAsDataURL(blob); });
    S.logos[x.club.id] = url; save(); return { logoUrl: url, size: blob.size, contentType: blob.type };
  });
  on('DELETE', '/clubs/:id/logo', (req, p) => { const x = ctx(req, p.id, 'owner'); delete S.logos[x.club.id]; save(); return [204]; });

  // assinatura
  const pubPlan = (p) => ({ id: p.id, code: p.code, name: p.name, interval: p.interval, priceCents: p.priceCents, currency: p.currency, maxMembers: p.maxMembers });
  on('GET', '/plans', () => ({ plans: S.plans.filter((p) => p.active).sort((a, b) => a.priceCents - b.priceCents).map(pubPlan) }));
  on('GET', '/clubs/:id/subscription', (req, p) => {
    const x = ctx(req, p.id, 'owner'); const s = subOf(x.club.id); const plan = s.planId && planBy(s.planId);
    return { subscription: Object.assign({}, s, subState(s)), plan: plan ? pubPlan(plan) : null, invoices: S.invoices.filter((i) => i.subscriptionId === s.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  });
  on('POST', '/clubs/:id/subscription', (req, p) => {
    const x = ctx(req, p.id, 'owner', true); const b = req.body || {}; const plan = planBy(b.planId);
    if (!plan || !plan.active) throw nf('Plano não encontrado.');
    const doc = digits(b.billingDocument); if (doc.length !== 11 && doc.length !== 14) throw bad('CPF ou CNPJ inválido.');
    const s = subOf(x.club.id); S.invoices.forEach((i) => { if (i.subscriptionId === s.id && i.status === 'pendente') i.status = 'cancelada'; });
    Object.assign(s, { billingName: b.billingName, billingDocument: doc, billingEmail: b.billingEmail });
    const inv = { id: uid(), subscriptionId: s.id, planId: plan.id, amountCents: plan.priceCents, currency: 'BRL', status: 'pendente', dueAt: new Date(Date.now() + 3 * DAY).toISOString(), paidAt: null, periodStart: null, periodEnd: null, providerRef: null, paymentUrl: null, createdAt: now() };
    S.invoices.push(inv); save();
    return [201, { invoice: inv, instructions: 'Fatura registrada. Na simulação, confirme o pagamento no Painel da plataforma.' }];
  });
  on('POST', '/clubs/:id/subscription/:act', (req, p) => {
    const x = ctx(req, p.id, 'owner', true); const s = subOf(x.club.id);
    if (p.act === 'cancel') { if (s.status !== 'ativa') throw bad('Não há assinatura paga para cancelar.'); s.cancelAtPeriodEnd = true; }
    else if (p.act === 'resume') { if (!s.cancelAtPeriodEnd) throw bad('A assinatura não está cancelada.'); s.cancelAtPeriodEnd = false; }
    else throw nf();
    save(); return { subscription: Object.assign({}, s, subState(s)) };
  });

  // painel da plataforma
  const adm = (req) => { const u = me(req); if (!u.isPlatformAdmin) throw forbid(); return u; };
  on('GET', '/admin/clubs', (req) => { adm(req); return { clubs: S.clubs.map((c) => { const o = userBy(c.ownerId); const s = subOf(c.id); return { id: c.id, name: c.name, slug: c.slug, church: c.church, region: c.region, createdAt: c.createdAt, admin: { id: o.id, name: o.name, username: o.username, email: o.email || null, phone: o.phone || null }, members: S.memberships.filter((m) => m.clubId === c.id && m.status === 'ativo').length, subscription: Object.assign(subState(s), { planId: s.planId }) }; }).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')) }; });
  on('GET', '/admin/invoices', (req) => { adm(req); return { invoices: S.invoices.map((i) => { const s = S.subs.find((k) => k.id === i.subscriptionId); const c = clubBy(s.clubId); return Object.assign({}, i, { club: { id: c.id, name: c.name }, billingName: s.billingName, billingDocument: s.billingDocument, billingEmail: s.billingEmail }); }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }; });
  on('POST', '/admin/invoices/:i/paid', (req, p) => {
    adm(req); const inv = S.invoices.find((i) => i.id === p.i); if (!inv) throw nf('Fatura não encontrada.'); if (inv.status !== 'pendente') throw bad('Essa fatura não está pendente.');
    const plan = planBy(inv.planId); const s = S.subs.find((k) => k.id === inv.subscriptionId);
    const cur = s.status !== 'trial' && s.currentPeriodEnd && Date.parse(s.currentPeriodEnd) > Date.now() ? s.currentPeriodEnd : now();
    const end = periodEnd(cur, plan);
    Object.assign(inv, { status: 'paga', paidAt: now(), periodStart: cur, periodEnd: end, providerRef: (req.body || {}).reference || null });
    Object.assign(s, { status: 'ativa', planId: plan.id, currentPeriodStart: cur, currentPeriodEnd: end, cancelAtPeriodEnd: false });
    save(); return { invoice: inv };
  });
  on('POST', '/admin/clubs/:id/subscription/extend', (req, p) => {
    adm(req); const s = subOf(p.id); if (!s) throw nf(); const days = Number((req.body || {}).days) || 0;
    const plus = (d) => new Date(Math.max(Date.now(), d ? Date.parse(d) : 0) + days * DAY).toISOString();
    if (s.status !== 'trial' && s.currentPeriodEnd) s.currentPeriodEnd = plus(s.currentPeriodEnd); else { s.status = 'trial'; s.trialEndsAt = plus(s.trialEndsAt); }
    save(); return { subscription: Object.assign({}, s, subState(s)) };
  });
  on('GET', '/admin/plans', (req) => { adm(req); return { plans: S.plans }; });
  on('POST', '/admin/plans', (req) => {
    adm(req); const b = req.body || {}; if (S.plans.some((p) => p.code === b.code)) throw conflict('Já existe um plano com esse código.');
    const p = { id: uid(), code: b.code, name: b.name, interval: b.interval === 'anual' ? 'anual' : 'mensal', priceCents: b.priceCents | 0, currency: 'BRL', maxMembers: b.maxMembers || null, active: b.active !== false, createdAt: now() };
    S.plans.push(p); save(); return [201, { plan: p }];
  });
  on('PATCH', '/admin/plans/:p', (req, p) => { adm(req); const pl = planBy(p.p); if (!pl) throw nf('Plano não encontrado.'); Object.assign(pl, req.body || {}); save(); return { plan: pl }; });
  on('GET', '/admin/users', (req) => { adm(req); const q = (req.query.get('q') || '').toLowerCase(); return { users: S.users.filter((u) => !q || u.username.includes(q) || u.name.toLowerCase().includes(q)).map(pubUser) }; });
  on('PATCH', '/admin/users/:u', (req, p) => {
    const a = adm(req); if (p.u === a.id) throw bad('Você não pode alterar a própria conta por aqui.'); const u = userBy(p.u); if (!u) throw nf('Conta não encontrada.');
    const b = req.body || {}; if ('disabled' in b) { u.disabledAt = b.disabled ? now() : null; if (b.disabled) for (const k of Object.keys(S.sessions)) if (S.sessions[k] === u.id) delete S.sessions[k]; }
    if ('isPlatformAdmin' in b) u.isPlatformAdmin = !!b.isPlatformAdmin; save(); return { user: pubUser(u) };
  });

  /* ---------- intercepta fetch('/api/...') ---------- */
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    init = init || {};
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    const auth = headers.authorization || headers.Authorization || '';
    const req = { method, token: auth.replace(/^Bearer\s+/, ''), query: url.searchParams, body: null, rawBody: init.body };
    if (typeof init.body === 'string') { try { req.body = JSON.parse(init.body); } catch (e) { req.body = null; } }
    const path = decodeURI(url.pathname.slice(4));
    await new Promise((r) => setTimeout(r, 60)); // um pouco de "rede", para as telas se comportarem como no servidor
    try {
      for (const r of R) {
        if (r.method !== method) continue;
        const m = r.re.exec(path); if (!m) continue;
        let out = await r.fn(req, m.groups || {});
        let status = 200;
        if (Array.isArray(out)) { status = out[0]; out = out[1]; }
        return status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
      }
      throw nf('Rota não encontrada: ' + method + ' ' + path);
    } catch (e) {
      const st = e.status || 500;
      if (st === 500) console.error(e);
      return new Response(JSON.stringify({ error: e.code || 'internal', message: e.status ? e.message : 'Erro na simulação: ' + e.message }), { status: st, headers: { 'content-type': 'application/json' } });
    }
  };

  /* ---------- faixa da simulação ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div');
    bar.className = 'sim-bar';
    bar.innerHTML = '<span><b>Simulação da versão oficial.</b> Tudo fica salvo só neste navegador. Para testar o Painel da plataforma, use o código <code>' + ADMIN_CODE + '</code> em Meus clubes.</span><button type="button" class="sim-reset">Apagar dados da simulação</button>';
    document.body.insertBefore(bar, document.body.firstChild);
    let armed = false;
    bar.querySelector('.sim-reset').addEventListener('click', (ev) => {
      if (!armed) { armed = true; ev.target.textContent = 'Toque de novo para apagar tudo'; setTimeout(() => { armed = false; ev.target.textContent = 'Apagar dados da simulação'; }, 4000); return; }
      window.__TRILHA_SIM_RESET__();
    });
  });
})();
