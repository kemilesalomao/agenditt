// AgendIt — backend real: API REST + SQLite + JWT + frontend estático
// Rodar:  node server.js   →  https://agendit.com.br
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { db, uniqueSlug, uid, nowISO } = require('./db');
const push = require('./push');
push.init();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[AgendIt] ERRO: a variável de ambiente JWT_SECRET não está definida.');
  console.error('Defina um segredo forte antes de iniciar, por exemplo:');
  console.error('  Windows (PowerShell):  $env:JWT_SECRET="seu-segredo-forte"; node server.js');
  console.error('  Linux/macOS:           JWT_SECRET="seu-segredo-forte" node server.js');
  console.error('  Ou crie o arquivo backend/.env com JWT_SECRET=... e rode: node --env-file-if-exists=.env server.js');
  process.exit(1);
}
const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' }));

/* ---------- helpers ---------- */
const row = (sql, p) => db.prepare(sql).get(...(p || []));
const all = (sql, p) => db.prepare(sql).all(...(p || []));
const run = (sql, p) => db.prepare(sql).run(...(p || []));
const J = v => { try { return JSON.parse(v || '{}'); } catch { return {}; } };
const JJ = v => JSON.stringify(v == null ? {} : v);

let pdfBrowserH = null;
async function getPdfBrowser() {
  if (pdfBrowserH && pdfBrowserH.isConnected && pdfBrowserH.isConnected()) return pdfBrowserH;
  const puppeteer = require('puppeteer');
  if (pdfBrowserH) { try { await pdfBrowserH.close(); } catch {} }
  pdfBrowserH = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  return pdfBrowserH;
}

function signToken(user) {
  return jwt.sign({ uid: user.id, bid: user.business_id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
}
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autenticado.' });
  try {
    const data = jwt.verify(token, JWT_SECRET);
    const user = row('SELECT * FROM users WHERE id = ?', [data.uid]);
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'Sessão inválida.' });
    req.user = user;
    next();
  } catch { return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' }); }
}
function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Apenas o dono pode fazer isso.' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito ao administrador geral.' });
  next();
}
function pubBusiness(bid) {
  const b = row('SELECT id, name, slug, segment, phone, whatsapp, address, description, instagram, logo, plan FROM businesses WHERE id = ?', [bid]);
  return b || null;
}
function notify(bid, type, text) {
  run('INSERT INTO notifications (id, business_id, type, text, read, created_at) VALUES (?,?,?,?,0,?)', [uid('bn'), bid, type, text, nowISO()]);
}

/* ---------- E-mail transacional (redefinição de senha) ---------- */
const nodemailer = require('nodemailer');
function getSmtp() {
  const r = row('SELECT value FROM master_settings WHERE key = ?', ['smtp']);
  return r ? J(r.value) : {};
}
function smtpConfigured() {
  const c = getSmtp();
  return !!(c.host && c.port && c.user && c.pass && c.from);
}
async function sendMail({ to, subject, html, text }) {
  const c = getSmtp();
  if (!smtpConfigured()) throw new Error('EMAIL_NOT_CONFIGURED');
  const tr = nodemailer.createTransport({ host: c.host, port: +c.port || 587, secure: !!c.secure, auth: { user: c.user, pass: c.pass } });
  try {
    await tr.sendMail({ from: c.from, to, subject, html, text });
  } finally {
    tr.close();
  }
}
function recoveryHtml(name, code) {
  return `
  <div style="max-width:520px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;background:#0B0B10;color:#EDEDF5;border:1px solid #26262F;border-radius:14px;overflow:hidden;">
    <div style="background:#14141B;padding:20px 26px;border-bottom:1px solid #26262F;">
      <b style="font-size:18px;color:#D4AF37;">AgendIt</b>
    </div>
    <div style="padding:26px;">
      <p style="font-size:15px;margin:0 0 14px;">Olá, <b>${(name || '').replace(/</g, '&lt;')}</b>!</p>
      <p style="font-size:14px;color:#BBBACB;margin:0 0 18px;">Recebemos um pedido para redefinir sua senha. Use o código abaixo:</p>
      <div style="background:#14141B;border:1px solid rgba(212,175,55,.35);border-radius:10px;padding:18px;text-align:center;font-size:30px;letter-spacing:6px;color:#D4AF37;font-weight:bold;">${code}</div>
      <p style="font-size:12px;color:#77768A;margin:18px 0 0;">O código expira em <b>15 minutos</b>. Se não foi você, ignore este e-mail.</p>
    </div>
  </div>`;
}
function defaultChat() {
  return {
    title: 'Assistente Virtual',
    subtitle: 'Online',
    greeting: 'Olá! Bem-vindo(a) ao atendimento da {loja}. 🗓️',
    askName: 'Como posso chamar você? (Digite seu nome abaixo)',
    askPhone: 'Prazer, {nome}! Qual seu telefone? (só números com DDD)',
    phoneBad: 'Hmm, esse telefone parece incompleto. Pode digitar novamente? (DDD + número)',
    askService: 'Perfeito! O que você gostaria de agendar hoje?',
    serviceTitle: 'Selecione um serviço:',
    noServices: 'No momento não há serviços disponíveis. Tente mais tarde.',
    askStaff: 'Ótimo! Você escolheu {servico}. Com qual profissional deseja ser atendido?',
    noDates: 'Este profissional não tem horários livres nos próximos dias. Escolha outro:',
    askDate: 'Perfeito! Para qual dia você prefere?',
    noSlots: 'Sem horários livres neste dia. Escolha outra data:',
    askTime: 'E qual o melhor horário para você?',
    summary: 'Confira seu pedido:\n\n👤 {nome}\n💇 {servico}{prof}\n📅 {data} às {hora}\n💰 R$ {valor} — pago na empresa\n\nO pagamento não é feito aqui: você acerta com a empresa na hora do atendimento. 💬',
    postBook: '✅ Pedido registrado:\n\n👤 {nome}\n💇 {servico}{prof}\n📅 {data} às {hora}\n💰 R$ {valor}\n\n🔒 Pagamento: para garantir seu horário, é necessário pagar o sinal de 50% antes do atendimento. Você será encaminhada para o WhatsApp da loja para combinar o pagamento. 💬',
    waMsg: 'Olá, fiz um agendamento pelo site e gostaria de confirmar meu horário.\n\n👤 Nome: {nome}\n📅 Data: {data} às {hora}\n💇 Serviço: {servico}\n💰 Valor total: R$ {valor}\n💵 Entrada (50%): R$ {sinal}\n\nGostaria de pagar a entrada para confirmar meu agendamento. Aguardo informações para pagamento. Obrigado(a).',
    extraQuestions: [],
    askProfessional: true,
    askSinal: true,
    cancelNotice: true,
    cancelHours: 1,
    cancelMsg: '📌 Aviso de cancelamento: para cancelar seu pedido, avise com até {horas} de antecedência. Cancelamentos em cima da hora podem gerar taxa.',
    cancelWaMsg: 'Olá! 👋 Fiz um agendamento pelo site e gostaria de falar com vocês:\n\n👤 Nome: {nome}\n💇 Serviço: {servico}\n📅 Data: {data} às {hora}\n\nQuando puderem, me respondam por aqui. Obrigado!'
  };
}
function defaultSettings() {
  return {
    hours: { 1: { open: true, p1: ['09:00', '12:00'], p2: ['14:00', '19:00'] }, 2: { open: true, p1: ['09:00', '12:00'], p2: ['14:00', '19:00'] }, 3: { open: true, p1: ['09:00', '12:00'], p2: ['14:00', '19:00'] }, 4: { open: true, p1: ['09:00', '12:00'], p2: ['14:00', '19:00'] }, 5: { open: true, p1: ['09:00', '12:00'], p2: ['14:00', '19:00'] }, 6: { open: true, p1: ['08:00', '14:00'], p2: null } },
    rules: { minAdvanceHours: 2, maxAdvanceDays: 30, slotInterval: 15, requirePhone: true, requireEmail: false, showNotes: true, sinalMinutes: 30 },
    cancel: { allowCancel: true, cancelHours: 4, allowReschedule: true, rescheduleHours: 4 },
    payments: { methods: ['Pix', 'Dinheiro', 'Cartão'] },
    appearance: { primaryColor: '#D4AF37', logo: '', cover: '' },
    chat: defaultChat(),
    notifprefs: { newBooking: true, cancelled: true, rescheduled: true, newClient: true, reminder: true }
  };
}
function getSettings(bid) {
  let s = row('SELECT * FROM business_settings WHERE business_id = ?', [bid]);
  if (!s) {
    const d = defaultSettings();
    run('INSERT INTO business_settings (business_id, hours_json, rules_json, cancel_json, payments_json, appearance_json, notifprefs_json, chat_json) VALUES (?,?,?,?,?,?,?,?)',
      [bid, JJ(d.hours), JJ(d.rules), JJ(d.cancel), JJ(d.payments), JJ(d.appearance), JJ(d.notifprefs), JJ(d.chat)]);
    return d;
  }
  return { hours: J(s.hours_json), rules: { ...defaultSettings().rules, ...J(s.rules_json) }, cancel: J(s.cancel_json), payments: J(s.payments_json), appearance: J(s.appearance_json), notifprefs: J(s.notifprefs_json), chat: { ...defaultChat(), ...J(s.chat_json) } };
}
function staffWithDays(bid, onlyActive) {
  let list = all('SELECT * FROM staff WHERE business_id = ? ORDER BY name', [bid]);
  if (onlyActive) list = list.filter(s => s.active);
  return list.map(s => ({
    id: s.id, name: s.name, specialty: s.specialty, phone: s.phone,
    start: s.start_time, end: s.end_time, interval: s.interval_min, active: !!s.active, avatar: s.avatar,
    days: all('SELECT weekday FROM staff_days WHERE staff_id = ?', [s.id]).map(r => r.weekday),
    daysOff: all('SELECT date FROM staff_timeoff WHERE staff_id = ?', [s.id]).map(r => r.date)
  }));
}
function servicesWithStaff(bid, onlyActive) {
  let list = all('SELECT * FROM services WHERE business_id = ? ORDER BY name', [bid]);
  if (onlyActive) list = list.filter(s => s.active);
  return list.map(s => ({
    id: s.id, name: s.name, desc: s.description, duration: s.duration_min, price: s.price,
    category: s.category, image: s.image, active: !!s.active,
    staffIds: all('SELECT staff_id FROM service_staff WHERE service_id = ?', [s.id]).map(r => r.staff_id)
  }));
}

/* ---------- disponibilidade real ---------- */
const toMin = t => +String(t).slice(0, 2) * 60 + +String(t).slice(3, 5);
const fmtT = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
/* Reserva temporária: pedido 'pending' bloqueia o horário só dentro da janela de confirmação do sinal. */
function sinalMinutes(st) { return +((st.rules || {}).sinalMinutes) || 0; }
function isHoldExpired(apt, mins) {
  return !!mins && apt.status === 'pending' && Date.now() - new Date(apt.created_at).getTime() > mins * 60000;
}
function sweepHoldExpired(bid) {
  const mins = sinalMinutes(getSettings(bid));
  if (!mins) return;
  const cutoff = new Date(Date.now() - mins * 60000).toISOString();
  run("UPDATE appointments SET status='expired' WHERE business_id = ? AND status = 'pending' AND created_at < ?", [bid, cutoff]);
}
function computeSlots(bizId, serviceId, staffId, dateISO) {
  sweepHoldExpired(bizId);
  const st = getSettings(bizId);
  const svc = row('SELECT * FROM services WHERE id = ? AND business_id = ?', [serviceId, bizId]);
  if (!svc || !svc.active) return { slots: [], reason: 'Serviço indisponível.' };
  const sid = staffId ? String(staffId) : '';
  const stf = sid ? row('SELECT * FROM staff WHERE id = ? AND business_id = ?', [sid, bizId]) : null;
  if (sid) {
    if (!stf || !stf.active) return { slots: [], reason: 'Profissional indisponível.' };
    const linked = row('SELECT 1 FROM service_staff WHERE service_id = ? AND staff_id = ?', [serviceId, sid]);
    if (!linked) return { slots: [], reason: 'Profissional não realiza este serviço.' };
  }
  const day = new Date(dateISO + 'T12:00:00').getDay();
  const dh = (st.hours || {})[day];
  if (!dh || !dh.open) return { slots: [], reason: 'Fechado neste dia.' };
  if (sid) {
    const days = all('SELECT weekday FROM staff_days WHERE staff_id = ?', [sid]).map(r => r.weekday);
    if (!days.includes(day)) return { slots: [], reason: 'Profissional não atende neste dia.' };
    if (row('SELECT 1 FROM staff_timeoff WHERE staff_id = ? AND date = ?', [sid, dateISO])) return { slots: [], reason: 'Profissional de folga.' };
  }
  const wins = [];
  if (dh.p1) wins.push(dh.p1);
  if (dh.p2) wins.push(dh.p2);
  const s0 = sid ? toMin(stf.start_time) : 0, s1 = sid ? toMin(stf.end_time) : 1440;
  const step = (st.rules || {}).slotInterval || 15;
  const dur = svc.duration_min;
  let out = [];
  wins.forEach(w => {
    let t = Math.max(toMin(w[0]), s0);
    const end = Math.min(toMin(w[1]), s1);
    while (t + dur <= end) { out.push(fmtT(t)); t += step; }
  });
  const apts = sid
    ? all("SELECT time, duration_min, status, created_at FROM appointments WHERE business_id = ? AND staff_id = ? AND date = ? AND status NOT IN ('cancelled','expired')", [bizId, sid, dateISO])
    : all("SELECT time, duration_min, status, created_at FROM appointments WHERE business_id = ? AND date = ? AND status NOT IN ('cancelled','expired')", [bizId, dateISO]);
  const mins = sinalMinutes(st);
  const bloqueia = a => !isHoldExpired(a, mins);
  const blocks = all('SELECT start_time, end_time FROM blocks WHERE business_id = ? AND date = ? AND (staff_id = ? OR staff_id = ?)', [bizId, dateISO, 'all', sid || '']);
  const ov = (t0, d0, t1, d1) => { const a = toMin(t0), b = toMin(t1); return a < b + d1 && b < a + d0; };
  out = out.filter(t =>
    !apts.some(a => bloqueia(a) && ov(t, dur, a.time, a.duration_min || 30)) &&
    !blocks.some(b => ov(t, dur, b.start_time, toMin(b.end_time) - toMin(b.start_time)))
  );
  // antecedência mínima hoje
  const today = new Date();
  const todayISO = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  if (dateISO === todayISO) {
    const minH = ((st.rules || {}).minAdvanceHours) || 0;
    const nowMin = today.getHours() * 60 + today.getMinutes();
    out = out.filter(t => toMin(t) - nowMin >= minH * 60);
  }
  // limite de antecedência
  const maxD = ((st.rules || {}).maxAdvanceDays) || 30;
  const lim = new Date(); lim.setDate(lim.getDate() + maxD);
  const limISO = lim.toISOString().slice(0, 10);
  if (dateISO > limISO) return { slots: [], reason: 'Fora do limite de antecedência.' };
  if (dateISO < todayISO) return { slots: [], reason: 'Data no passado.' };
  return { slots: out };
}

/* ================= AUTH ================= */
app.post('/api/auth/register', (req, res) => {
  const { businessName, segment, ownerName, email, password, address, whatsapp } = req.body || {};
  if (!businessName || !ownerName || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });
  const mail = String(email).trim().toLowerCase();
  if (!/^[^@\s]+@(gmail|outlook)\.com$/i.test(mail)) return res.status(400).json({ error: 'Use um e-mail @gmail.com ou @outlook.com para criar a conta.' });
  const waRaw = String(whatsapp || '').replace(/\D/g, '');
  if (waRaw.length && waRaw.length !== 11) return res.status(400).json({ error: 'O WhatsApp deve ter 11 números (DDD + número).' });
  if (row('SELECT 1 FROM users WHERE email = ?', [mail])) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
  const bid = uid('biz');
  const slug = uniqueSlug(businessName);
  const now = nowISO();
  const wa = waRaw;
  run('INSERT INTO businesses (id, name, slug, segment, phone, whatsapp, address, plan, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [bid, businessName.trim(), slug, segment || 'outro', wa, wa, address || '', 'Profissional', 'pending', now]);
  const uidd = uid('user');
  run('INSERT INTO users (id, business_id, name, email, password_hash, role, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [uidd, bid, ownerName.trim(), mail, bcrypt.hashSync(password, 10), 'owner', 'pending', now]);
  const d = defaultSettings();
  run('INSERT INTO business_settings (business_id, hours_json, rules_json, cancel_json, payments_json, appearance_json, notifprefs_json, chat_json) VALUES (?,?,?,?,?,?,?,?)',
    [bid, JJ(d.hours), JJ(d.rules), JJ(d.cancel), JJ(d.payments), JJ(d.appearance), JJ(d.notifprefs), JJ(d.chat)]);
  const user = row('SELECT * FROM users WHERE id = ?', [uidd]);
  notify(bid, 'Boas-vindas', 'Conta criada! Cadastre serviços e profissionais para começar.');
  res.json({ token: signToken(user), user: pubUser(user), business: pubBusiness(bid) });
});
function pubUser(u) { return { id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, createdAt: u.created_at }; }

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = row('SELECT * FROM users WHERE email = ?', [String(email || '').trim().toLowerCase()]);
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  if (user.status !== 'active') {
    if (user.status === 'pending') {
      const sub = getSub(user.business_id);
      if (sub && ['cancelled', 'expired'].includes(sub.status)) return res.status(403).json({ error: 'Sua assinatura foi cancelada. Faça uma nova assinatura para reativar o acesso ao painel.', code: 'sub_cancelled' });
      return res.status(403).json({ error: 'Pagamento pendente no Kiwify. Sua conta será liberada assim que o pagamento for confirmado.', code: 'payment_pending' });
    }
    if (user.status === 'suspended') return res.status(403).json({ error: 'Sua conta foi suspensa pelo administrador do AgendIt. Para reativar, entre em contato com o suporte.', code: 'account_suspended' });
    if (user.status === 'blocked') return res.status(403).json({ error: 'Sua conta está bloqueada pelo administrador do AgendIt. Para desbloquear, entre em contato com o suporte.', code: 'account_blocked' });
    return res.status(403).json({ error: 'Usuário desativado. Fale com o administrador.', code: 'user_disabled' });
  }
  res.json({ token: signToken(user), user: pubUser(user), business: pubBusiness(user.business_id) });
});

app.post('/api/auth/forgot', async (req, res) => {
  const { email } = req.body || {};
  const user = row('SELECT * FROM users WHERE email = ?', [String(email || '').trim().toLowerCase()]);
  if (!user) return res.status(404).json({ error: 'E-mail não encontrado.' });
  if (!smtpConfigured()) return res.status(503).json({ error: 'EMAIL_NOT_CONFIGURED' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  run('DELETE FROM recovery_codes WHERE user_id = ?', [user.id]);
  run('INSERT INTO recovery_codes (id, user_id, code_hash, expires_at, attempts) VALUES (?,?,?,?,0)',
    [uid('rc'), user.id, bcrypt.hashSync(code, 8), Date.now() + 15 * 60 * 1000]);
  try {
    await sendMail({
      to: user.email,
      subject: 'Seu código de recuperação — AgendIt',
      html: recoveryHtml(user.name, code),
      text: 'Seu código de recuperação AgendIt: ' + code + ' (válido por 15 minutos).'
    });
    res.json({ ok: true, name: user.name }); // código NÃO é devolvido na resposta
  } catch (e) {
    if (e && e.message === 'EMAIL_NOT_CONFIGURED') return res.status(503).json({ error: 'EMAIL_NOT_CONFIGURED' });
    res.status(500).json({ error: 'Não foi possível enviar o e-mail. Verifique as credenciais SMTP.' });
  }
});

app.post('/api/auth/verify', (req, res) => {
  const { email, code } = req.body || {};
  const user = row('SELECT * FROM users WHERE email = ?', [String(email || '').trim().toLowerCase()]);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const rc = row('SELECT * FROM recovery_codes WHERE user_id = ? ORDER BY rowid DESC LIMIT 1', [user.id]);
  if (!rc || rc.expires_at < Date.now()) return res.status(400).json({ error: 'Código expirado. Solicite um novo.' });
  if (rc.attempts >= 5) return res.status(400).json({ error: 'Muitas tentativas. Solicite um novo código.' });
  if (!bcrypt.compareSync(String(code || ''), rc.code_hash)) {
    run('UPDATE recovery_codes SET attempts = attempts + 1 WHERE id = ?', [rc.id]);
    return res.status(400).json({ error: 'Código incorreto.' });
  }
  res.json({ ok: true });
});

app.post('/api/auth/reset', (req, res) => {
  const { email, code, newPassword } = req.body || {};
  const user = row('SELECT * FROM users WHERE email = ?', [String(email || '').trim().toLowerCase()]);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const rc = row('SELECT * FROM recovery_codes WHERE user_id = ? ORDER BY rowid DESC LIMIT 1', [user.id]);
  if (!rc || rc.expires_at < Date.now()) return res.status(400).json({ error: 'Código expirado. Solicite um novo.' });
  if (rc.attempts >= 5) { run('DELETE FROM recovery_codes WHERE user_id = ?', [user.id]); return res.status(400).json({ error: 'Muitas tentativas. Solicite um novo código.' }); }
  if (!bcrypt.compareSync(String(code || ''), rc.code_hash)) {
    run('UPDATE recovery_codes SET attempts = attempts + 1 WHERE id = ?', [rc.id]);
    return res.status(400).json({ error: 'Código incorreto.' });
  }
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'A nova senha deve ter ao menos 6 caracteres.' });
  run('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(newPassword, 10), user.id]);
  run('DELETE FROM recovery_codes WHERE user_id = ?', [user.id]);
  res.json({ ok: true });
});

/* ================= CONFIG MASTER (SMTP) ================= */
app.get('/api/master/smtp', requireAuth, requireOwner, (req, res) => {
  const c = getSmtp();
  res.json({ configured: smtpConfigured(), config: { host: c.host || '', port: c.port || 587, user: c.user || '', secure: !!c.secure, from: c.from || '' } });
});
app.put('/api/master/smtp', requireAuth, requireOwner, (req, res) => {
  const b = req.body || {};
  if (!b.host || !b.port || !b.user || !b.from) return res.status(400).json({ error: 'Preencha host, porta, usuário, chave e remetente.' });
  const old = getSmtp();
  const cfg = { host: String(b.host).trim(), port: +b.port || 587, user: String(b.user).trim(), pass: String(b.pass || '').trim() || old.pass || '', secure: !!b.secure, from: String(b.from).trim() };
  run('INSERT INTO master_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', ['smtp', JJ(cfg)]);
  res.json({ ok: true, configured: smtpConfigured() });
});
app.post('/api/master/smtp/test', requireAuth, requireOwner, async (req, res) => {
  if (!smtpConfigured()) return res.status(503).json({ error: 'EMAIL_NOT_CONFIGURED' });
  try {
    await sendMail({
      to: req.user.email,
      subject: 'Teste de e-mail — AgendIt',
      html: '<p>Este é um e-mail de teste do <b>AgendIt</b>. Se você recebeu, o SMTP está funcionando! 🎉</p>',
      text: 'Teste de e-mail AgendIt — SMTP OK.'
    });
    res.json({ ok: true, sentTo: req.user.email });
  } catch (e) {
    res.status(500).json({ error: 'Não foi possível enviar o e-mail de teste. Verifique as credenciais SMTP.' });
  }
});

/* ================= KIWIFY (pagamento da assinatura) ================= */
const KIWIFY_DEFAULTS = { link: 'https://pay.kiwify.com.br/spd0Pnz', webhookToken: '' };
const PLAN_PRICE = { Profissional: 29.9, Premium: 59.9, Básico: 19.9, Gratuito: 0 };
function getPlans() {
  const r = row("SELECT value FROM master_settings WHERE key = 'platform'");
  const p = r ? J(r.value) : {};
  return Object.assign({}, PLAN_PRICE, (p && p.plans) || {});
}
function getKiwify() { const r = row('SELECT value FROM master_settings WHERE key = ?', ['kiwify']); return Object.assign({}, KIWIFY_DEFAULTS, r ? J(r.value) : {}); }
function getSub(bid) { return row('SELECT * FROM subscriptions WHERE business_id = ?', [bid]); }
function addMonths(iso, n) { const d = new Date(iso); d.setMonth(d.getMonth() + n); return d.toISOString(); }
function blockBusinessAccess(u) {
  run("UPDATE users SET status = 'pending' WHERE id = ?", [u.id]);
  run("UPDATE businesses SET status = 'pending' WHERE id = ?", [u.business_id]);
}
function upsertSubPayment(bid, sub, payDate, priceReais, planName, ksubId) {
  const now = nowISO();
  const base = sub || { plan_name: planName || 'Profissional', kiwify_subscription_id: ksubId || '', price_reais: priceReais, started_at: null, last_renewal_at: null, paid_until: null, status: 'pending' };
  const paidUntil = addMonths(payDate, 1);
  const started = base.started_at ? (base.started_at < payDate ? base.started_at : payDate) : payDate;
  const renew = base.last_renewal_at && base.last_renewal_at > payDate ? base.last_renewal_at : payDate;
  const until = base.paid_until && base.paid_until > paidUntil ? base.paid_until : paidUntil;
  /* nova compra depois de cancelado reativa a assinatura */
  const status = 'active';
  if (!sub) {
    run('INSERT INTO subscriptions (business_id, kiwify_subscription_id, plan_name, price_reais, status, started_at, last_renewal_at, paid_until, next_billing, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [bid, ksubId || '', planName || 'Profissional', priceReais, status, started, renew, until, until, now, now]);
  } else {
    run('UPDATE subscriptions SET kiwify_subscription_id = ?, plan_name = ?, price_reais = ?, status = ?, started_at = ?, last_renewal_at = ?, paid_until = ?, next_billing = ?, cancel_requested_at = NULL, cancel_scheduled_at = NULL, cancelled_at = NULL, cancel_reason = ?, updated_at = ? WHERE business_id = ?',
      [ksubId || sub.kiwify_subscription_id || '', planName || sub.plan_name, priceReais != null ? priceReais : sub.price_reais, status, started, renew, until, until, '', now, bid]);
  }
}
/* Encerra o ciclo: bloqueia o acesso quando o período pago termina (cancelado ou pago não renovado). */
function checkSubscriptions() {
  const list = all("SELECT * FROM subscriptions WHERE status IN ('active','cancel_scheduled','late') AND paid_until IS NOT NULL AND paid_until <= ?", [nowISO()]);
  list.forEach(s => {
    const u = row('SELECT * FROM users WHERE business_id = ? AND role = ?', [s.business_id, 'owner']);
    const newStatus = s.status === 'cancel_scheduled' ? 'cancelled' : 'expired';
    run('UPDATE subscriptions SET status = ?, cancelled_at = ?, updated_at = ? WHERE business_id = ?', [newStatus, s.cancelled_at || nowISO(), nowISO(), s.business_id]);
    subEvent(s.business_id, newStatus, 'Fim do período pago sem renovação.', 'sistema');
    if (u) blockBusinessAccess(u);
  });
}
function kiwifyLog(entry) {
  const k = getKiwify();
  const log = Array.isArray(k._log) ? k._log : [];
  log.push(Object.assign({ at: nowISO() }, entry));
  run('INSERT INTO master_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', ['kiwify', JJ(Object.assign({}, k, { _log: log.slice(-30) }))]);
}
app.post('/api/kiwify/webhook', (req, res) => {
  const raw = req.body || {};
  const body = raw.order || raw;
  const k = getKiwify();
  const token = req.headers['x-kiwify-token'] || req.headers['x-webhook-token'] || '';
  if (k.webhookToken && token !== k.webhookToken) { kiwifyLog({ type: 'denied', order: body.order_id || '', email: body.customer_email || '' }); return res.status(401).json({ ok: false, error: 'Token inválido.' }); }
  const email = String(body.customer_email || body.email || (body.customer && body.customer.email) || raw.customer_email || '').trim().toLowerCase();
  const order = String(body.order_id || raw.order_id || '');
  const event = String(body.webhook_event_type || raw.webhook_event_type || '').toLowerCase();
  const st = String(body.order_status || body.status || raw.status || '').toLowerCase();
  const paid = !event || /approved|paid|billing_approved/.test(event + ' ' + st);
  const failed = /refund|cancel|chargeback|expired|late/.test(event + ' ' + st);
  const cents = Number(((body.Commissions && body.Commissions.charge_amount) != null ? body.Commissions.charge_amount : (body.value_amount != null ? body.value_amount : 0))) || 0;
  const priceReais = Math.round(cents) / 100;
  const payStr = body.approved_date || body.payment_date || body.recurrence_date || '';
  const payDate = payStr ? (String(payStr).replace(' ', 'T')) : nowISO();
  const planName = (String(body.product_name || body.productName || '').toLowerCase().includes('premium') ? 'Premium' : 'Profissional');
  let u = email ? row('SELECT * FROM users WHERE email = ?', [email]) : null;

  if (/subscription_cancel/i.test(event)) {
    if (u) {
      const sub = getSub(u.business_id);
      if (sub) {
        run('UPDATE subscriptions SET status = ?, cancel_scheduled_at = ?, cancel_reason = ?, updated_at = ? WHERE business_id = ?', ['cancel_scheduled', nowISO(), 'Confirmado pela Kiwify (webhook subscription_canceled).', nowISO(), u.business_id]);
        subEvent(u.business_id, 'cancel_scheduled', 'Confirmado pela Kiwify.', 'kiwify');
      }
      kiwifyLog({ type: 'cancel_scheduled', order, email });
      return res.json({ ok: true, cancelScheduled: true });
    }
    kiwifyLog({ type: 'cancel_no_user', order, email });
    return res.json({ ok: true });
  }

  if (paid) {
    if (u) {
      upsertSubPayment(u.business_id, getSub(u.business_id), payDate, priceReais, planName, body.subscription_id || body.reccurrence_id || '');
      run("UPDATE users SET status = 'active' WHERE id = ?", [u.id]);
      run("UPDATE businesses SET status = 'active' WHERE id = ?", [u.business_id]);
      subEvent(u.business_id, 'payment', 'Pagamento confirmado de R$ ' + priceReais.toFixed(2).replace('.', ',') + ' — ' + planName + '.', 'kiwify');
      subPayment(u.business_id, order, priceReais, 'paid', payDate);
      kiwifyLog({ type: 'activated', order, email, value: priceReais });
      return res.json({ ok: true, activated: true, email: u.email });
    }
    kiwifyLog({ type: 'paid_no_user', order, email });
    return res.status(404).json({ ok: false, error: 'E-mail não encontrado.' });
  }
  if (failed) {
    const isLate = /late/.test(event + ' ' + st);
    if (u) {
      const sub = getSub(u.business_id);
      if (sub && sub.status !== 'cancel_scheduled') {
        run('UPDATE subscriptions SET status = ?, updated_at = ? WHERE business_id = ?', [isLate ? 'late' : 'expired', nowISO(), u.business_id]);
        subEvent(u.business_id, isLate ? 'late' : 'failed', 'Pagamento ' + (isLate ? 'atrasado' : 'recusado') + ' pela Kiwify.', 'kiwify');
      }
      /* atraso não bloqueia na hora: mantém acesso até o fim do período pago e o scheduler encerra depois */
      if (!isLate) blockBusinessAccess(u);
      kiwifyLog({ type: 'blocked', order, email, status: st, late: isLate });
    }
    return res.json({ ok: true, blocked: true });
  }
  kiwifyLog({ type: 'ignored', order, email, event, status: st });
  res.json({ ok: true, ignored: true });
});
app.get('/api/master/kiwify', requireAuth, requireOwner, (req, res) => {
  const k = getKiwify();
  res.json({ link: k.link, webhookToken: !!k.webhookToken, recent: k._log || [] });
});
app.put('/api/master/kiwify', requireAuth, requireOwner, (req, res) => {
  const b = req.body || {};
  const k = getKiwify();
  const link = String(b.link || k.link || KIWIFY_DEFAULTS.link).trim();
  const webhookToken = b.webhookToken === undefined ? k.webhookToken : String(b.webhookToken).trim();
  run('INSERT INTO master_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', ['kiwify', JJ({ link, webhookToken, _log: k._log || [] })]);
  res.json({ ok: true, link, webhookToken: !!webhookToken });
});

/* ================= MINHA ASSINATURA ================= */
const SUB_STATUS = {
  active: ['Ativa', 'b-green'],
  pending: ['Pendente', 'b-gold'],
  late: ['Pagamento atrasado', 'b-gold'],
  suspended: ['Suspensa', 'b-red'],
  cancel_scheduled: ['Cancelamento agendado', 'b-gold'],
  cancelled: ['Cancelada', 'b-red'],
  expired: ['Cancelada', 'b-red']
};
function subEvent(bid, type, detail, actor) {
  run('INSERT INTO subscription_events (id, business_id, type, detail, actor, created_at) VALUES (?,?,?,?,?,?)',
    [uid('se'), bid, type, detail || '', actor || 'kiwify', nowISO()]);
}
function subPayment(bid, orderId, amountReais, status, paidAt) {
  run('INSERT INTO subscription_payments (id, business_id, order_id, amount_reais, status, channel, paid_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [uid('sp'), bid, orderId || '', amountReais != null ? amountReais : 0, status || 'paid', 'Kiwify', paidAt || nowISO(), nowISO()]);
}
function subView(bid) {
  const b = row('SELECT plan FROM businesses WHERE id = ?', [bid]);
  const sub = getSub(bid);
  const plan = (b && b.plan) || 'Profissional';
  const plans = getPlans();
  const price = (sub && sub.price_reais != null && sub.price_reais > 0) ? sub.price_reais : (plans[plan] != null ? plans[plan] : null);
  const status = sub ? sub.status : 'pending';
  const st = SUB_STATUS[status] || SUB_STATUS.pending;
  return {
    plan,
    pricePlan: plans[plan] != null ? plans[plan] : null,
    price,
    status,
    statusLabel: st[0],
    statusClass: st[1],
    hasWebhook: !!sub,
    nextBilling: sub ? sub.next_billing : null,
    paidUntil: sub ? sub.paid_until : null,
    startedAt: sub ? sub.started_at : null,
    cancelRequestedAt: sub ? sub.cancel_requested_at : null,
    cancelScheduledAt: sub ? sub.cancel_scheduled_at : null,
    cancelledAt: sub ? sub.cancelled_at : null,
    canCancel: !!sub && ['active', 'pending', 'late'].includes(status),
    canReactivate: sub && status === 'cancel_scheduled',
    renewUrl: getKiwify().link
  };
}
app.get('/api/subscription', requireAuth, requireOwner, (req, res) => res.json(subView(req.user.business_id)));app.post('/api/subscription/cancel', requireAuth, requireOwner, (req, res) => {
  const bid = req.user.business_id;
  const sub = getSub(bid);
  if (!sub) return res.status(400).json({ error: 'Não localizamos a assinatura na Kiwify (webhook ainda não registrou nenhum pagamento). Contate o suporte para cancelar.' });
  if (!['active', 'pending', 'late'].includes(sub.status)) return res.status(400).json({ error: sub.status === 'cancel_scheduled' ? 'O cancelamento já está agendado.' : 'Esta assinatura já está encerrada.' });
  const now = nowISO();
  run('UPDATE subscriptions SET status = ?, cancel_requested_at = ?, cancel_scheduled_at = ?, cancel_reason = ?, updated_at = ? WHERE business_id = ?',
    ['cancel_scheduled', now, now, 'Solicitado pelo proprietário no painel.', now, bid]);
  subEvent(bid, 'cancel_scheduled', 'Solicitado pelo proprietário no painel.', 'owner');
  res.json(Object.assign({ ok: true }, subView(bid)));
});
app.post('/api/subscription/reactivate', requireAuth, requireOwner, (req, res) => {
  const bid = req.user.business_id;
  const sub = getSub(bid);
  if (!sub || sub.status !== 'cancel_scheduled') return res.status(400).json({ error: 'Não há cancelamento agendado para reativar.' });
  run('UPDATE subscriptions SET status = ?, cancel_requested_at = NULL, cancel_scheduled_at = NULL, cancel_reason = ?, updated_at = ? WHERE business_id = ?',
    ['active', '', nowISO(), bid]);
  subEvent(bid, 'reactivated', 'Reativada pelo proprietário no painel.', 'owner');
  res.json(Object.assign({ ok: true }, subView(bid)));
});

/* ================= ADMINISTRADOR GERAL ================= */
function getPlatformCfg() {
  const r = row("SELECT value FROM master_settings WHERE key = 'platform'");
  const k = getKiwify();
  return Object.assign({
    platformName: 'AgendIt',
    logo: 'Agendit_logo-wt-nobg.png',
    contactEmail: '',
    contactPhone: '',
    kiwifyLink: k.link,
    trialFirstMonth: 9.9,
    plans: PLAN_PRICE,
    systemMessages: {}
  }, r ? J(r.value) : {});
}
function savePlatformCfg(c) {
  run("INSERT INTO master_settings (key, value) VALUES ('platform', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JJ(c)]);
}
const ADMIN_BIZ_SQL = `SELECT b.id, b.name, b.slug, b.segment, b.phone, b.whatsapp, b.plan, b.status AS biz_status, b.created_at AS biz_created,
    u.id AS uid, u.name AS owner_name, u.email, u.role, u.status AS user_status,
    s.status AS sub_status, s.plan_name, s.price_reais, s.next_billing, s.paid_until, s.started_at,
    (SELECT COUNT(*) FROM services sv WHERE sv.business_id = b.id) AS svc,
    (SELECT COUNT(*) FROM staff sf WHERE sf.business_id = b.id) AS stf,
    (SELECT COUNT(*) FROM appointments ap WHERE ap.business_id = b.id) AS apc
  FROM businesses b
  LEFT JOIN users u ON u.business_id = b.id AND u.role != 'staff'
  LEFT JOIN subscriptions s ON s.business_id = b.id`;

app.get('/api/admin/dashboard', requireAuth, requireAdmin, (req, res) => {
  const total = row('SELECT COUNT(*) c FROM businesses').c;
  const activeSubs = row("SELECT COUNT(*) c FROM subscriptions WHERE status = 'active'").c;
  const suspendedSubs = row("SELECT COUNT(*) c FROM subscriptions WHERE status = 'suspended'").c;
  const cancelledSubs = row("SELECT COUNT(*) c FROM subscriptions WHERE status IN ('cancelled','expired')").c;
  const blockedUsers = row("SELECT COUNT(*) c FROM users WHERE status = 'blocked'").c;
  const pendingUsers = row("SELECT COUNT(*) c FROM users WHERE status = 'pending'").c;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const newSubscribers = row('SELECT COUNT(*) c FROM businesses WHERE created_at >= ?', [monthStart.toISOString()]).c;
  const monthlyRevenue = row("SELECT COALESCE(SUM(amount_reais),0) s FROM subscription_payments WHERE status = 'paid' AND paid_at >= ?", [monthStart.toISOString()]).s;
  res.json({
    totalSubscribers: total, activeSubs, suspendedSubs, cancelledSubs, blockedUsers, pendingUsers, newSubscribers, monthlyRevenue,
    platform: {
      services: row('SELECT COUNT(*) c FROM services').c,
      staff: row('SELECT COUNT(*) c FROM staff').c,
      appointments: row('SELECT COUNT(*) c FROM appointments').c,
      db: all("SELECT name FROM sqlite_master WHERE type='table'").length
    }
  });
});

app.get('/api/admin/subscribers', requireAuth, requireAdmin, (req, res) => {
  res.json(all(ADMIN_BIZ_SQL + ' ORDER BY b.created_at DESC'));
});

app.get('/api/admin/subscribers/:bid', requireAuth, requireAdmin, (req, res) => {
  const b = row('SELECT * FROM businesses WHERE id = ?', [req.params.bid]);
  if (!b) return res.status(404).json({ error: 'Empresa não encontrada.' });
  const business = { id: b.id, name: b.name, slug: b.slug, segment: b.segment, phone: b.phone, whatsapp: b.whatsapp, address: b.address, description: b.description, instagram: b.instagram, logo: b.logo, plan: b.plan, status: b.status, createdAt: b.created_at };
  res.json({
    business,
    owner: row("SELECT id, name, email, role, status, created_at FROM users WHERE business_id = ? AND role != 'staff' ORDER BY created_at LIMIT 1", [b.id]),
    users: all("SELECT id, name, email, role, status, created_at FROM users WHERE business_id = ? ORDER BY created_at", [b.id]),
    subscription: getSub(b.id),
    payments: all('SELECT * FROM subscription_payments WHERE business_id = ? ORDER BY paid_at DESC', [b.id]),
    events: all('SELECT * FROM subscription_events WHERE business_id = ? ORDER BY created_at DESC LIMIT 60', [b.id]),
    services: all('SELECT id, name, description, duration_min AS duration, price, category, active, created_at FROM services WHERE business_id = ? ORDER BY name', [b.id]),
    staff: staffWithDays(b.id, false),
    settings: getSettings(b.id),
    counts: {
      appointments: row('SELECT COUNT(*) c FROM appointments WHERE business_id = ?', [b.id]).c,
      clients: row('SELECT COUNT(*) c FROM clients WHERE business_id = ?', [b.id]).c,
      revenue: row("SELECT COALESCE(SUM(paid),0) s FROM transactions WHERE business_id = ? AND status = 'paid'", [b.id]).s
    }
  });
});

function ensureSubForBiz(bid) {
  let sub = getSub(bid);
  if (!sub) {
    const b = row('SELECT plan, created_at FROM businesses WHERE id = ?', [bid]);
    const plan = (b && b.plan) || 'Profissional';
    const now = nowISO();
    run('INSERT INTO subscriptions (business_id, kiwify_subscription_id, plan_name, price_reais, status, created_at, updated_at) VALUES (?,?,?,?,\'pending\',?,?)',
      [bid, '', plan, getPlans()[plan] != null ? getPlans()[plan] : null, now, now]);
    sub = getSub(bid);
  }
  return sub;
}
app.post('/api/admin/subscribers/:bid/suspend', requireAuth, requireAdmin, (req, res) => {
  const bid = req.params.bid;
  if (!row('SELECT 1 FROM businesses WHERE id = ?', [bid])) return res.status(404).json({ error: 'Empresa não encontrada.' });
  ensureSubForBiz(bid);
  const now = nowISO();
  run('UPDATE subscriptions SET status = ? , updated_at = ? WHERE business_id = ?', ['suspended', now, bid]);
  run("UPDATE users SET status = 'suspended' WHERE business_id = ? AND role != 'admin'", [bid]);
  run("UPDATE businesses SET status = 'suspended' WHERE id = ?", [bid]);
  subEvent(bid, 'suspended', 'Assinatura suspensa pelo administrador geral.', 'admin');
  res.json({ ok: true, subscription: getSub(bid) });
});
app.post('/api/admin/subscribers/:bid/reactivate', requireAuth, requireAdmin, (req, res) => {
  const bid = req.params.bid;
  if (!row('SELECT 1 FROM businesses WHERE id = ?', [bid])) return res.status(404).json({ error: 'Empresa não encontrada.' });
  ensureSubForBiz(bid);
  const now = nowISO();
  run("UPDATE subscriptions SET status = 'active', cancelled_at = NULL, cancel_reason = '', updated_at = ? WHERE business_id = ?", [now, bid]);
  run("UPDATE users SET status = 'active' WHERE business_id = ? AND status = 'suspended' AND role != 'admin'", [bid]);
  run("UPDATE businesses SET status = 'active' WHERE id = ?", [bid]);
  subEvent(bid, 'reactivated', 'Assinatura reativada pelo administrador geral.', 'admin');
  res.json({ ok: true, subscription: getSub(bid) });
});
app.post('/api/admin/subscribers/:bid/cancel', requireAuth, requireAdmin, (req, res) => {
  const bid = req.params.bid;
  if (!row('SELECT 1 FROM businesses WHERE id = ?', [bid])) return res.status(404).json({ error: 'Empresa não encontrada.' });
  ensureSubForBiz(bid);
  const now = nowISO();
  run("UPDATE subscriptions SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'Cancelada pelo administrador geral.', updated_at = ? WHERE business_id = ?", [now, now, bid]);
  run("UPDATE users SET status = 'pending' WHERE business_id = ? AND role != 'admin'", [bid]);
  run("UPDATE businesses SET status = 'pending' WHERE id = ?", [bid]);
  subEvent(bid, 'cancelled', 'Cancelada pelo administrador geral.', 'admin');
  res.json({ ok: true, subscription: getSub(bid) });
});
app.post('/api/admin/subscribers/:bid/plan', requireAuth, requireAdmin, (req, res) => {
  const bid = req.params.bid;
  const plan = String((req.body || {}).plan || '');
  const plans = getPlans();
  if (!plans[plan]) return res.status(400).json({ error: 'Plano inválido. Use Básico, Profissional, Premium ou Gratuito.' });
  if (!row('SELECT 1 FROM businesses WHERE id = ?', [bid])) return res.status(404).json({ error: 'Empresa não encontrada.' });
  ensureSubForBiz(bid);
  const now = nowISO();
  run('UPDATE businesses SET plan = ? WHERE id = ?', [plan, bid]);
  run('UPDATE subscriptions SET plan_name = ?, price_reais = ?, updated_at = ? WHERE business_id = ?', [plan, plans[plan], now, bid]);
  subEvent(bid, 'plan_changed', 'Plano alterado para ' + plan + ' (R$ ' + String(plans[plan]).replace('.', ',') + ') pelo administrador geral.', 'admin');
  res.json({ ok: true, subscription: getSub(bid) });
});
app.post('/api/admin/subscribers/:bid/block', requireAuth, requireAdmin, (req, res) => {
  const bid = req.params.bid;
  if (!row('SELECT 1 FROM businesses WHERE id = ?', [bid])) return res.status(404).json({ error: 'Empresa não encontrada.' });
  run("UPDATE users SET status = 'blocked' WHERE business_id = ? AND role != 'admin'", [bid]);
  run("UPDATE businesses SET status = 'blocked' WHERE id = ?", [bid]);
  subEvent(bid, 'access_blocked', 'Acesso bloqueado pelo administrador geral.', 'admin');
  res.json({ ok: true, businessStatus: 'blocked' });
});
app.post('/api/admin/subscribers/:bid/unblock', requireAuth, requireAdmin, (req, res) => {
  const bid = req.params.bid;
  if (!row('SELECT 1 FROM businesses WHERE id = ?', [bid])) return res.status(404).json({ error: 'Empresa não encontrada.' });
  run("UPDATE users SET status = 'active' WHERE business_id = ? AND role != 'admin'", [bid]);
  const sub = getSub(bid);
  const bizStatus = sub && ['suspended', 'cancelled', 'expired'].includes(sub.status) ? (sub.status === 'suspended' ? 'suspended' : 'pending') : 'active';
  run('UPDATE businesses SET status = ? WHERE id = ?', [bizStatus, bid]);
  subEvent(bid, 'access_unblocked', 'Acesso desbloqueado pelo administrador geral.', 'admin');
  res.json({ ok: true, businessStatus: bizStatus });
});

app.post('/api/admin/subscribers/:bid/users', requireAuth, requireAdmin, (req, res) => {
  const bid = req.params.bid;
  const b = row('SELECT 1 FROM businesses WHERE id = ?', [bid]);
  if (!b) return res.status(404).json({ error: 'Empresa não encontrada.' });
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Preencha nome, e-mail e senha.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });
  const mail = String(email).trim().toLowerCase();
  if (row('SELECT 1 FROM users WHERE email = ?', [mail])) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
  const rl = role === 'staff' ? 'staff' : 'owner';
  const uidd = uid('user');
  run('INSERT INTO users (id, business_id, name, email, password_hash, role, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [uidd, bid, String(name).trim(), mail, bcrypt.hashSync(password, 10), rl, 'active', nowISO()]);
  res.json({ ok: true, user: row('SELECT id, name, email, role, status, created_at FROM users WHERE id = ?', [uidd]) });
});
app.put('/api/admin/users/:uid', requireAuth, requireAdmin, (req, res) => {
  const u = row('SELECT * FROM users WHERE id = ?', [req.params.uid]);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (u.role === 'admin') return res.status(400).json({ error: 'O administrador geral não pode ser editado aqui.' });
  const { name, email, role, status } = req.body || {};
  if (email) {
    const mail = String(email).trim().toLowerCase();
    const dup = row('SELECT 1 FROM users WHERE email = ? AND id != ?', [mail, u.id]);
    if (dup) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    run('UPDATE users SET email = ? WHERE id = ?', [mail, u.id]);
  }
  if (name) run('UPDATE users SET name = ? WHERE id = ?', [String(name).trim(), u.id]);
  if (role && ['owner', 'staff'].includes(role)) run('UPDATE users SET role = ? WHERE id = ?', [role, u.id]);
  if (status && ['active', 'pending', 'blocked', 'suspended'].includes(status)) run('UPDATE users SET status = ? WHERE id = ?', [status, u.id]);
  res.json({ ok: true, user: row('SELECT id, name, email, role, status, created_at FROM users WHERE id = ?', [u.id]) });
});
app.post('/api/admin/users/:uid/reset-password', requireAuth, requireAdmin, (req, res) => {
  const u = row('SELECT * FROM users WHERE id = ?', [req.params.uid]);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const pass = String((req.body || {}).password || '');
  if (pass.length < 6) return res.status(400).json({ error: 'A nova senha deve ter ao menos 6 caracteres.' });
  run('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(pass, 10), u.id]);
  res.json({ ok: true });
});
app.delete('/api/admin/users/:uid', requireAuth, requireAdmin, (req, res) => {
  const u = row('SELECT * FROM users WHERE id = ?', [req.params.uid]);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (u.role === 'admin') return res.status(400).json({ error: 'O administrador geral não pode ser excluído.' });
  run('DELETE FROM users WHERE id = ?', [u.id]);
  res.json({ ok: true });
});

app.get('/api/admin/businesses', requireAuth, requireAdmin, (req, res) => {
  const rows = all(ADMIN_BIZ_SQL + ' ORDER BY b.created_at DESC');
  res.json(rows);
});

app.get('/api/admin/config', requireAuth, requireAdmin, (req, res) => res.json(getPlatformCfg()));
app.put('/api/admin/config', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const cur = getPlatformCfg();
  const plans = {};
  ['Básico', 'Profissional', 'Premium', 'Gratuito'].forEach(k => { const v = Number((b.plans || {})[k]); if (Number.isFinite(v) && v >= 0) plans[k] = v; });
  const next = {
    platformName: String((b.platformName || '').trim() || cur.platformName),
    logo: String((b.logo || '').trim()),
    contactEmail: String((b.contactEmail || '').trim()),
    contactPhone: String((b.contactPhone || '').trim()),
    kiwifyLink: String((b.kiwifyLink || '').trim() || cur.kiwifyLink),
    trialFirstMonth: Number.isFinite(Number(b.trialFirstMonth)) ? Number(b.trialFirstMonth) : cur.trialFirstMonth,
    plans: Object.assign({}, cur.plans, plans),
    systemMessages: Object.assign({}, cur.systemMessages || {}, (b.systemMessages && typeof b.systemMessages === 'object') ? b.systemMessages : {})
  };
  savePlatformCfg(next);
  const k = getKiwify();
  if (next.kiwifyLink !== k.link) run("INSERT INTO master_settings (key, value) VALUES ('kiwify', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JJ(Object.assign({}, k, { link: next.kiwifyLink }))]);
  res.json({ ok: true, config: next });
});

/* ================= SESSÃO ================= */
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: pubUser(req.user), business: pubBusiness(req.user.business_id) });
});
app.put('/api/me/profile', requireAuth, requireOwner, (req, res) => {
  const { name, phone, whatsapp, address, description, instagram, logo } = req.body || {};
  if (name) run('UPDATE businesses SET name = ? WHERE id = ?', [String(name), req.user.business_id]);
  run('UPDATE businesses SET phone = ?, whatsapp = ?, address = ?, description = ?, instagram = ?, logo = ? WHERE id = ?',
    [phone || '', whatsapp ? String(whatsapp).trim() : '', address || '', description || '', instagram || '', logo || '', req.user.business_id]);
  res.json({ business: pubBusiness(req.user.business_id) });
});

/* ================= COLEÇÕES (isoladas por negócio) ================= */
const COLLECTIONS = ['services', 'staff', 'clients', 'appointments', 'transactions', 'notifications', 'blocks', 'supportTickets'];
function serialize(col, bid) {
  if (col === 'services') return servicesWithStaff(bid, false);
  if (col === 'staff') return staffWithDays(bid, false);
  if (col === 'clients') return all('SELECT * FROM clients WHERE business_id = ? ORDER BY name', [bid]).map(c => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, birth: c.birth, notes: c.notes, status: c.status, createdAt: c.created_at }));
  if (col === 'appointments') { sweepHoldExpired(bid); return all('SELECT * FROM appointments WHERE business_id = ? ORDER BY date DESC, time DESC LIMIT 2000', [bid]).map(a => ({
    id: a.id, clientId: a.client_id, clientName: a.client_name, phone: a.phone, serviceId: a.service_id, service: a.service_name,
    staffId: a.staff_id, staff: a.staff_name, date: a.date, time: a.time, duration: a.duration_min, price: a.price,
    status: a.status, notes: a.notes, createdAt: a.created_at
  })); }
  if (col === 'transactions') return all('SELECT * FROM transactions WHERE business_id = ? ORDER BY date DESC LIMIT 2000', [bid]).map(t => ({
    id: t.id, aptId: t.appointment_id, client: t.client_name, service: t.service_name, total: t.total, paid: t.paid,
    remaining: t.remaining, method: t.method, status: t.status, date: t.date
  }));
  if (col === 'notifications') return all('SELECT * FROM notifications WHERE business_id = ? ORDER BY created_at DESC LIMIT 200', [bid]).map(n => ({ id: n.id, type: n.type, text: n.text, read: !!n.read, date: n.created_at }));
  if (col === 'blocks') return all('SELECT * FROM blocks WHERE business_id = ? ORDER BY date', [bid]).map(b => ({ id: b.id, staffId: b.staff_id, date: b.date, start: b.start_time, end: b.end_time, reason: b.reason }));
  if (col === 'supportTickets') return all('SELECT * FROM support_tickets WHERE business_id = ? ORDER BY created_at DESC', [bid]).map(t => ({ id: t.id, subject: t.subject, message: t.message, status: t.status, date: t.created_at }));
  return null;
}
app.get('/api/data/:col', requireAuth, (req, res) => {
  const { col } = req.params;
  if (col === 'settings') return res.json(getSettings(req.user.business_id));
  if (col === 'profile') return res.json(pubBusiness(req.user.business_id));
  if (!COLLECTIONS.includes(col)) return res.status(404).json({ error: 'Coleção inválida.' });
  res.json(serialize(col, req.user.business_id));
});

/* Escritas granulares (criar/atualizar/excluir com validação + isolamento) */
app.post('/api/data/:col', requireAuth, requireOwner, (req, res) => {
  const { col } = req.params;
  const bid = req.user.business_id;
  const b = req.body || {};
  const now = nowISO();
  try {
    if (col === 'services') {
      if (!b.name || !(+b.duration) || isNaN(+b.price)) return res.status(400).json({ error: 'Preencha nome, duração e preço.' });
      const id = uid('svc');
      run('INSERT INTO services (id, business_id, name, description, duration_min, price, category, image, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [id, bid, b.name.trim(), b.desc || '', +b.duration, +b.price, b.category || 'Geral', b.image || '', b.active === false ? 0 : 1, now]);
      (b.staffIds || []).forEach(sid => { try { run('INSERT INTO service_staff (service_id, staff_id) VALUES (?,?)', [id, sid]); } catch {} });
      return res.json(servicesWithStaff(bid, false).find(s => s.id === id));
    }
    if (col === 'staff') {
      if (!b.name) return res.status(400).json({ error: 'Informe o nome.' });
      const id = uid('stf');
      run('INSERT INTO staff (id, business_id, name, specialty, phone, start_time, end_time, interval_min, active, avatar, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [id, bid, b.name.trim(), b.specialty || '', b.phone || '', b.start || '09:00', b.end || '19:00', +b.interval || 15, b.active === false ? 0 : 1, '', now]);
      (b.days || [1, 2, 3, 4, 5, 6]).forEach(d => run('INSERT INTO staff_days (staff_id, weekday) VALUES (?,?)', [id, d]));
      (b.daysOff || []).forEach(d => { try { run('INSERT INTO staff_timeoff (staff_id, date) VALUES (?,?)', [id, d]); } catch {} });
      (b.serviceIds || []).forEach(sid => { try { run('INSERT INTO service_staff (service_id, staff_id) VALUES (?,?)', [sid, id]); } catch {} });
      return res.json(staffWithDays(bid, false).find(s => s.id === id));
    }
    if (col === 'clients') {
      if (!b.name || !b.phone) return res.status(400).json({ error: 'Informe nome e telefone.' });
      const id = uid('cli');
      run('INSERT INTO clients (id, business_id, name, phone, email, birth, notes, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, bid, b.name.trim(), b.phone.trim(), b.email || '', b.birth || '', b.notes || '', b.status || 'active', now]);
      notify(bid, 'Novo cliente', b.name.trim() + ' foi cadastrado.');
      return res.json({ id });
    }
    if (col === 'appointments') return res.status(400).json({ error: 'Use /api/actions/appointment.' });
    if (col === 'blocks') {
      if (!b.date || !b.start || !b.end || b.start >= b.end) return res.status(400).json({ error: 'Informe data e intervalo válidos.' });
      const id = uid('bl');
      run('INSERT INTO blocks (id, business_id, staff_id, date, start_time, end_time, reason) VALUES (?,?,?,?,?,?,?)',
        [id, bid, b.staffId || 'all', b.date, b.start, b.end, b.reason || '']);
      return res.json({ id });
    }
    if (col === 'notifications') { notify(bid, b.type || 'Aviso', b.text || ''); return res.json({ ok: true }); }
    if (col === 'supportTickets') {
      if (!b.subject || !b.message) return res.status(400).json({ error: 'Preencha assunto e mensagem.' });
      const id = uid('sp');
      run('INSERT INTO support_tickets (id, business_id, subject, message, status, created_at) VALUES (?,?,?,?,?,?)', [id, bid, b.subject, b.message, 'open', now]);
      notify(bid, 'Chamado enviado', 'Seu chamado "' + b.subject + '" foi registrado.');
      return res.json({ id });
    }
    return res.status(404).json({ error: 'Coleção inválida.' });
  } catch (e) { return res.status(500).json({ error: 'Erro ao salvar.' }); }
});

app.put('/api/data/:col/:id', requireAuth, requireOwner, (req, res) => {
  const { col, id } = req.params;
  const bid = req.user.business_id;
  const b = req.body || {};
  const own = (table) => row(`SELECT 1 FROM ${table} WHERE id = ? AND business_id = ?`, [id, bid]);
  try {
    if (col === 'services') {
      if (!own('services')) return res.status(404).json({ error: 'Não encontrado.' });
      run('UPDATE services SET name=?, description=?, duration_min=?, price=?, category=?, image=?, active=? WHERE id=?',
        [b.name, b.desc || '', +b.duration || 30, +b.price || 0, b.category || 'Geral', b.image || '', b.active === false ? 0 : 1, id]);
      run('DELETE FROM service_staff WHERE service_id = ?', [id]);
      (b.staffIds || []).forEach(sid => { try { run('INSERT INTO service_staff (service_id, staff_id) VALUES (?,?)', [id, sid]); } catch {} });
      return res.json({ ok: true });
    }
    if (col === 'staff') {
      if (!own('staff')) return res.status(404).json({ error: 'Não encontrado.' });
      run('UPDATE staff SET name=?, specialty=?, phone=?, start_time=?, end_time=?, interval_min=?, active=? WHERE id=?',
        [b.name, b.specialty || '', b.phone || '', b.start || '09:00', b.end || '19:00', +b.interval || 15, b.active === false ? 0 : 1, id]);
      run('DELETE FROM staff_days WHERE staff_id = ?', [id]);
      (b.days || []).forEach(d => run('INSERT INTO staff_days (staff_id, weekday) VALUES (?,?)', [id, d]));
      run('DELETE FROM staff_timeoff WHERE staff_id = ?', [id]);
      (b.daysOff || []).forEach(d => { try { run('INSERT INTO staff_timeoff (staff_id, date) VALUES (?,?)', [id, d]); } catch {} });
      run('DELETE FROM service_staff WHERE staff_id = ?', [id]);
      (b.serviceIds || []).forEach(sid => { try { run('INSERT INTO service_staff (service_id, staff_id) VALUES (?,?)', [sid, id]); } catch {} });
      return res.json({ ok: true });
    }
    if (col === 'clients') {
      if (!own('clients')) return res.status(404).json({ error: 'Não encontrado.' });
      run('UPDATE clients SET name=?, phone=?, email=?, birth=?, notes=?, status=? WHERE id=?',
        [b.name, b.phone, b.email || '', b.birth || '', b.notes || '', b.status || 'active', id]);
      return res.json({ ok: true });
    }
    if (col === 'settings') {
      const map = { hours: 'hours_json', rules: 'rules_json', cancel: 'cancel_json', payments: 'payments_json', appearance: 'appearance_json', notifprefs: 'notifprefs_json', chat: 'chat_json' };
      const keys = Object.keys(b).filter(k => map[k]);
      if (!keys.length) return res.status(400).json({ error: 'Nada para salvar.' });
      getSettings(bid);
      keys.forEach(k => run(`UPDATE business_settings SET ${map[k]} = ? WHERE business_id = ?`, [JJ(b[k]), bid]));
      return res.json({ ok: true });
    }
    return res.status(404).json({ error: 'Coleção inválida.' });
  } catch { return res.status(500).json({ error: 'Erro ao salvar.' }); }
});

app.delete('/api/data/:col/:id', requireAuth, requireOwner, (req, res) => {
  const { col, id } = req.params;
  const bid = req.user.business_id;
  const ownbe = (table) => row(`SELECT 1 FROM ${table} WHERE id = ? AND business_id = ?`, [id, bid]);
  try {
    if (col === 'services') {
      if (!ownbe('services')) return res.status(404).json({ error: 'Não encontrado.' });
      const fut = row("SELECT 1 FROM appointments WHERE service_id = ? AND business_id = ? AND status IN ('confirmed','pending') LIMIT 1", [id, bid]);
      if (fut) return res.status(409).json({ error: 'Há agendamentos futuros com este serviço.' });
      run('DELETE FROM services WHERE id = ?', [id]);
      return res.json({ ok: true });
    }
    if (col === 'staff') {
      if (!ownbe('staff')) return res.status(404).json({ error: 'Não encontrado.' });
      const fut = row("SELECT 1 FROM appointments WHERE staff_id = ? AND business_id = ? AND date >= date('now','localtime') AND status IN ('confirmed','pending') LIMIT 1", [id, bid]);
      if (fut) return res.status(409).json({ error: 'Há agendamentos futuros com este profissional.' });
      run('DELETE FROM staff WHERE id = ?', [id]);
      return res.json({ ok: true });
    }
    if (col === 'clients') {
      if (!ownbe('clients')) return res.status(404).json({ error: 'Não encontrado.' });
      run('DELETE FROM clients WHERE id = ?', [id]);
      return res.json({ ok: true });
    }
    if (col === 'blocks') {
      if (!ownbe('blocks')) return res.status(404).json({ error: 'Não encontrado.' });
      run('DELETE FROM blocks WHERE id = ?', [id]);
      return res.json({ ok: true });
    }
    return res.status(404).json({ error: 'Coleção inválida.' });
  } catch { return res.status(500).json({ error: 'Erro ao excluir.' }); }
});

/* ================= AÇÕES DE AGENDAMENTO ================= */
app.post('/api/actions/appointment', requireAuth, requireOwner, (req, res) => {
  const bid = req.user.business_id;
  const { id, action, date, time } = req.body || {};
  const apt = row('SELECT * FROM appointments WHERE id = ? AND business_id = ?', [id, bid]);
  if (!apt) return res.status(404).json({ error: 'Agendamento não encontrado.' });
  const now = nowISO();
  if (action === 'confirm' && apt.status === 'pending') {
    run("UPDATE appointments SET status = 'confirmed' WHERE id = ?", [id]);
    notify(bid, 'Agendamento atualizado', apt.client_name + ' — ' + apt.service_name + ' confirmado.');
    const slug = row('SELECT slug FROM businesses WHERE id = ?', [bid]);
    push.sendToAppointment(bid, id, {
      title: '✅ Agendamento confirmado',
      body: `Olá ${apt.client_name}! Seu horário de ${apt.service_name} (${apt.date.split('-').reverse().join('/')} às ${apt.time}) foi CONFIRMADO. Nos vemos lá!`,
      url: '/agendamento.html?b=' + (slug && slug.slug ? slug.slug : ''),
      ttl: 86400
    }).catch(() => {});
    return res.json({ ok: true });
  }
  if (action === 'cancel' && !['cancelled', 'completed'].includes(apt.status)) {
    run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", [id]);
    run("UPDATE transactions SET status = 'cancelled' WHERE appointment_id = ?", [id]);
    notify(bid, 'Agendamento cancelado', apt.client_name + ' — ' + apt.service_name + '.');
    const slug = row('SELECT slug FROM businesses WHERE id = ?', [bid]);
    push.sendToAppointment(bid, id, {
      title: '❌ Agendamento cancelado',
      body: `Olá ${apt.client_name}! Seu horário de ${apt.service_name} foi cancelado. Se quiser, marque um novo pelo nosso site.`,
      url: '/agendamento.html?b=' + (slug && slug.slug ? slug.slug : ''),
      ttl: 86400
    }).catch(() => {});
    return res.json({ ok: true });
  }
  if (action === 'complete' && apt.status === 'confirmed') {
    run("UPDATE appointments SET status = 'completed' WHERE id = ?", [id]);
    const tx = row('SELECT * FROM transactions WHERE appointment_id = ?', [id]);
    if (tx) run("UPDATE transactions SET paid = total, remaining = 0, status = 'paid' WHERE id = ?", [tx.id]);
    return res.json({ ok: true });
  }
  if (action === 'delete') {
    run('DELETE FROM transactions WHERE appointment_id = ?', [id]);
    run('DELETE FROM appointments WHERE id = ?', [id]);
    return res.json({ ok: true });
  }
  if (action === 'reschedule' && date && time) {
    // valida conflito no novo horário
    const chk = computeSlots(bid, apt.service_id, apt.staff_id, date);
    if (!chk.slots.includes(time)) return res.status(409).json({ error: 'Horário indisponível para este profissional.' });
    run('UPDATE appointments SET date = ?, time = ? WHERE id = ?', [date, time, id]);
    run('UPDATE transactions SET date = ? WHERE appointment_id = ?', [date + 'T' + time + ':00', id]);
    notify(bid, 'Agendamento reagendado', apt.client_name + ' — novo horário: ' + date.split('-').reverse().join('/') + ' às ' + time + '.');
    const slug = row('SELECT slug FROM businesses WHERE id = ?', [bid]);
    push.sendToAppointment(bid, id, {
      title: '🔁 Agendamento alterado',
      body: `Olá ${apt.client_name}! Seu horário de ${apt.service_name} foi alterado para ${date.split('-').reverse().join('/')} às ${time}. Atualize sua agenda.`,
      url: '/agendamento.html?b=' + (slug && slug.slug ? slug.slug : ''),
      ttl: 86400
    }).catch(() => {});
    return res.json({ ok: true });
  }
  return res.status(400).json({ error: 'Ação inválida para este status.' });
});

app.post('/api/actions/create-appointment', requireAuth, requireOwner, (req, res) => {
  const bid = req.user.business_id;
  const { clientId, clientName, phone, serviceId, staffId, date, time, price, notes } = req.body || {};
  const svc = row('SELECT * FROM services WHERE id = ? AND business_id = ?', [serviceId, bid]);
  const stf = row('SELECT * FROM staff WHERE id = ? AND business_id = ?', [staffId, bid]);
  if (!svc || !svc.active) return res.status(400).json({ error: 'Serviço inválido.' });
  if (!stf || !stf.active) return res.status(400).json({ error: 'Profissional inválido.' });
  const chk = computeSlots(bid, serviceId, staffId, date);
  if (!chk.slots.includes(time)) return res.status(409).json({ error: chk.reason || 'Horário indisponível.' });
  let cid = clientId || null, cname = clientName || '', cphone = phone || '';
  if (clientId) {
    const c = row('SELECT * FROM clients WHERE id = ? AND business_id = ?', [clientId, bid]);
    if (!c) return res.status(400).json({ error: 'Cliente inválido.' });
    cname = c.name; cphone = c.phone; cid = c.id;
  } else {
    if (!cname || !cphone) return res.status(400).json({ error: 'Informe nome e telefone do cliente.' });
    cid = uid('cli');
    run('INSERT INTO clients (id, business_id, name, phone, email, birth, notes, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)', [cid, bid, cname.trim(), cphone.trim(), '', '', '', 'active', nowISO()]);
    notify(bid, 'Novo cliente', cname.trim() + ' foi cadastrado.');
  }
  const total = +price || svc.price;
  const aid = uid('apt');
  const now = nowISO();
  run('INSERT INTO appointments (id, business_id, client_id, client_name, phone, service_id, service_name, staff_id, staff_name, date, time, duration_min, price, status, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [aid, bid, cid, cname, cphone, serviceId, svc.name, staffId, stf.name, date, time, svc.duration_min, total, 'confirmed', notes || '', now]);
  run('INSERT INTO transactions (id, business_id, appointment_id, client_name, service_name, total, paid, remaining, method, status, date, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [uid('tx'), bid, aid, cname, svc.name, total, 0, total, 'Pix', 'pending', date + 'T' + time + ':00', now]);
  notify(bid, 'Novo agendamento', cname + ' — ' + svc.name + ' (' + date.split('-').reverse().join('/') + ' ' + time + ').');
  res.json({ ok: true, id: aid, status: 'confirmed' });
});

app.post('/api/actions/receive', requireAuth, requireOwner, (req, res) => {
  const bid = req.user.business_id;
  const { transactionId, method } = req.body || {};
  const tx = row('SELECT * FROM transactions WHERE id = ? AND business_id = ?', [transactionId, bid]);
  if (!tx) return res.status(404).json({ error: 'Transação não encontrada.' });
  run('UPDATE transactions SET paid = total, remaining = 0, status = ?, method = ? WHERE id = ?', ['paid', method || tx.method, transactionId]);
  res.json({ ok: true });
});

app.post('/api/actions/notify', requireAuth, requireOwner, (req, res) => {
  notify(req.user.business_id, req.body.type || 'Aviso', req.body.text || '');
  res.json({ ok: true });
});
app.post('/api/actions/read-notification', requireAuth, (req, res) => {
  const { id, all } = req.body || {};
  if (all) run('UPDATE notifications SET read = 1 WHERE business_id = ?', [req.user.business_id]);
  else run('UPDATE notifications SET read = 1 WHERE id = ? AND business_id = ?', [id, req.user.business_id]);
  res.json({ ok: true });
});

/* ================= USUÁRIOS (dono) ================= */
app.post('/api/users', requireAuth, requireOwner, (req, res) => {
  const { name, email, password, role, companyId } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Preencha nome, e-mail e senha.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });
  const mail = String(email).trim().toLowerCase();
  if (row('SELECT 1 FROM users WHERE email = ?', [mail])) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
  const id = uid('user');
  run('INSERT INTO users (id, business_id, name, email, password_hash, role, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, req.user.business_id, name.trim(), mail, bcrypt.hashSync(password, 10), role === 'staff' ? 'staff' : 'owner', 'active', nowISO()]);
  res.json({ ok: true, id });
});
app.get('/api/users', requireAuth, requireOwner, (req, res) => {
  const list = all('SELECT * FROM users WHERE business_id = ? ORDER BY name', [req.user.business_id]);
  const comp = pubBusiness(req.user.business_id);
  res.json(list.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, createdAt: u.created_at, company: comp ? comp.name : '' })));
});
app.put('/api/users/:id', requireAuth, requireOwner, (req, res) => {
  const u = row('SELECT * FROM users WHERE id = ? AND business_id = ?', [req.params.id, req.user.business_id]);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const { status, newPassword, name, email } = req.body || {};
  if (name) run('UPDATE users SET name = ? WHERE id = ?', [String(name).trim(), u.id]);
  if (email) {
    const mail = String(email).trim().toLowerCase();
    const other = row('SELECT 1 FROM users WHERE email = ? AND id != ?', [mail, u.id]);
    if (other) return res.status(409).json({ error: 'Este e-mail já está em uso.' });
    run('UPDATE users SET email = ? WHERE id = ?', [mail, u.id]);
  }
  if (status) {
    if (u.id === req.user.id) return res.status(400).json({ error: 'Você não pode desativar a própria conta.' });
    run('UPDATE users SET status = ? WHERE id = ?', [status, u.id]);
  }
  if (newPassword) {
    if (String(newPassword).length < 6) return res.status(400).json({ error: 'A nova senha deve ter ao menos 6 caracteres.' });
    run('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(newPassword, 10), u.id]);
  }
  res.json({ ok: true });
});
app.delete('/api/users/:id', requireAuth, requireOwner, (req, res) => {
  const u = row('SELECT * FROM users WHERE id = ? AND business_id = ?', [req.params.id, req.user.business_id]);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'Você não pode excluir a própria conta.' });
  run('DELETE FROM users WHERE id = ?', [u.id]);
  res.json({ ok: true });
});
app.post('/api/support', requireAuth, (req, res) => {
  const { subject, message } = req.body || {};
  if (!subject || !message) return res.status(400).json({ error: 'Preencha assunto e mensagem.' });
  run('INSERT INTO support_tickets (id, business_id, subject, message, status, created_at) VALUES (?,?,?,?,?,?)', [uid('sp'), req.user.business_id, subject, message, 'open', nowISO()]);
  notify(req.user.business_id, 'Chamado enviado', 'Seu chamado foi registrado. Retornaremos em breve.');
  res.json({ ok: true });
});

/* Logo PDF → PNG (o site exibe a 1ª página como imagem) */
app.post('/api/logo/png', requireAuth, requireOwner, async (req, res) => {
  try {
    const pdf = String((req.body && req.body.pdf) || '');
    if (!pdf.startsWith('data:application/pdf')) return res.status(400).json({ error: 'Envie um PDF válido.' });
    const buf = Buffer.from(pdf.split(',')[1] || '', 'base64');
    if (!buf.length) return res.status(400).json({ error: 'PDF vazio.' });
    const tmp = path.join(os.tmpdir(), 'agendit-logo-' + Date.now() + '-' + Math.floor(Math.random() * 9999) + '.pdf');
    fs.writeFileSync(tmp, buf);
    let w = 1200, h = 1200;
    const mb = buf.toString('latin1').match(/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/i);
    if (mb) { const pw = +mb[3] - +mb[1], ph = +mb[4] - +mb[2]; if (pw > 0 && ph > 0) { w = Math.min(pw, 2000); h = Math.min(ph, 2000); } }
    const browser = await getPdfBrowser();
    const page = await browser.newPage();
    let png = null;
    try {
      await page.setViewport({ width: Math.round(w), height: Math.round(h) });
      await page.goto('file:///' + tmp.replace(/\\/g, '/'), { waitUntil: 'networkidle0', timeout: 30000 });
      await new Promise(r => setTimeout(r, 600));
      png = await page.screenshot({ type: 'png' });
    } finally {
      try { await page.close(); } catch {}
      try { fs.unlinkSync(tmp); } catch {}
    }
    res.json({ png: 'data:image/png;base64,' + png.toString('base64') });
  } catch (e) {
    res.status(500).json({ error: 'Não foi possível converter o PDF.' });
  }
});

/* ================= PÚBLICO (sem login) ================= */
app.get('/api/public/checkout-link', (req, res) => res.json({ link: getKiwify().link }));
app.get('/api/public/:slug', (req, res) => {
  const b = row("SELECT * FROM businesses WHERE slug = ? AND status = 'active'", [req.params.slug]);
  if (!b) return res.status(404).json({ error: 'Página não encontrada.' });
  const st = getSettings(b.id);
  res.json({
    business: { name: b.name, slug: b.slug, segment: b.segment, phone: b.phone, whatsapp: b.whatsapp || '', address: b.address, description: b.description, instagram: b.instagram, logo: b.logo || (st.appearance.logo || 'Logo_Agendit.jpg'), color: st.appearance.primaryColor || '#D4AF37' },
    push: { enabled: true, publicKey: push.getPublicKey() },
    services: servicesWithStaff(b.id, true),
    staff: staffWithDays(b.id, true).map(s => ({ id: s.id, name: s.name, specialty: s.specialty, days: s.days, daysOff: s.daysOff })),
    rules: { requirePhone: st.rules.requirePhone !== false, requireEmail: !!st.rules.requireEmail, showNotes: st.rules.showNotes !== false, maxAdvanceDays: st.rules.maxAdvanceDays || 30, sinalMinutes: sinalMinutes(st) },
    chat: { ...defaultChat(), ...(st.chat || {}) },
    openDays: [0, 1, 2, 3, 4, 5, 6].filter(d => st.hours && st.hours[d] && st.hours[d].open)
  });
});
app.get('/api/public/:slug/slots', (req, res) => {
  const b = row("SELECT * FROM businesses WHERE slug = ? AND status = 'active'", [req.params.slug]);
  if (!b) return res.status(404).json({ error: 'Página não encontrada.' });
  const { serviceId, staffId, date } = req.query || {};
  if (!serviceId || !date) return res.status(400).json({ error: 'Parâmetros incompletos.' });
  res.json(computeSlots(b.id, serviceId, staffId || '', date));
});
app.post('/api/public/:slug/book', (req, res) => {
  const b = row("SELECT * FROM businesses WHERE slug = ? AND status = 'active'", [req.params.slug]);
  if (!b) return res.status(404).json({ error: 'Página não encontrada.' });
  const { clientName, phone, serviceId, staffId, date, time, notes } = req.body || {};
  const st = getSettings(b.id);
  if (!clientName || (st.rules.requirePhone !== false && !phone)) return res.status(400).json({ error: 'Informe nome e telefone.' });
  const svc = row('SELECT * FROM services WHERE id = ? AND business_id = ? AND active = 1', [serviceId, b.id]);
  if (!svc) return res.status(400).json({ error: 'Serviço inválido.' });
  const sid = staffId ? String(staffId) : '';
  let stfName = 'Sem profissional';
  if (sid) {
    const stf = row('SELECT * FROM staff WHERE id = ? AND business_id = ? AND active = 1', [sid, b.id]);
    if (!stf) return res.status(400).json({ error: 'Profissional inválido.' });
    stfName = stf.name;
  }
  /* Controle de concorrência: checar + reservar atomicamente para dois pedidos simultâneos não ocuparem o mesmo horário. */
  let aid = null;
  try {
    db.exec('BEGIN IMMEDIATE');
    const chk = computeSlots(b.id, serviceId, sid, date);
    if (!chk.slots.includes(time)) {
      db.exec('ROLLBACK');
      return res.status(409).json({ error: chk.reason || 'Horário indisponível. Escolha outro.' });
    }
    let cli = phone ? row('SELECT * FROM clients WHERE business_id = ? AND phone = ?', [b.id, String(phone).trim()]) : null;
    if (!cli) {
      cli = { id: uid('cli') };
      run('INSERT INTO clients (id, business_id, name, phone, email, birth, notes, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [cli.id, b.id, String(clientName).trim(), String(phone || '').trim(), '', '', '', 'active', nowISO()]);
      cli.name = String(clientName).trim();
      notify(b.id, 'Novo cliente', cli.name + ' fez o primeiro agendamento pela página pública.');
    }
    aid = uid('apt');
    const now = nowISO();
    run('INSERT INTO appointments (id, business_id, client_id, client_name, phone, service_id, service_name, staff_id, staff_name, date, time, duration_min, price, status, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [aid, b.id, cli.id, cli.name, String(phone || '').trim(), serviceId, svc.name, sid || null, stfName, date, time, svc.duration_min, svc.price, 'pending', notes || '', now]);
    run('INSERT INTO transactions (id, business_id, appointment_id, client_name, service_name, total, paid, remaining, method, status, date, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [uid('tx'), b.id, aid, cli.name, svc.name, svc.price, 0, svc.price, 'Pix', 'pending', date + 'T' + time + ':00', now]);
    notify(b.id, 'Novo pedido', cli.name + ' pediu ' + svc.name + ' (' + date.split('-').reverse().join('/') + ' ' + time + ') — confira no painel.');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    return res.status(500).json({ error: 'Erro ao reservar o horário.' });
  }
  res.json({ ok: true, id: aid, status: 'pending' });
});
/* Registra a PushSubscription do cliente (web push) vinculada ao agendamento/cliente. */
app.post('/api/public/:slug/push/register', (req, res) => {
  const b = row("SELECT * FROM businesses WHERE slug = ? AND status = 'active'", [req.params.slug]);
  if (!b) return res.status(404).json({ error: 'Página não encontrada.' });
  const { appointmentId, phone, subscription } = req.body || {};
  let clientId = null, pphone = String(phone || '').trim();
  if (appointmentId) {
    const apt = row('SELECT client_id, phone, business_id FROM appointments WHERE id = ? AND business_id = ?', [appointmentId, b.id]);
    if (!apt) return res.status(404).json({ error: 'Agendamento não encontrado.' });
    clientId = apt.client_id;
    if (!pphone) pphone = String(apt.phone || '').trim();
  }
  try {
    const r = push.register({ businessId: b.id, clientId, phone: pphone, subscription });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/public/:slug/push/unregister', (req, res) => {
  push.unregister((req.body || {}).endpoint || '');
  res.json({ ok: true });
});

/* ================= RELATÓRIOS (calculados no servidor) ================= */
app.get('/api/reports/summary', requireAuth, (req, res) => {
  const bid = req.user.business_id;
  const { from, to } = req.query || {};
  const f = from || '2000-01-01', t = to || '2999-12-31';
  const apts = all('SELECT * FROM appointments WHERE business_id = ? AND date >= ? AND date <= ?', [bid, f, t]);
  const txs = all('SELECT * FROM transactions WHERE business_id = ? AND substr(date,1,10) >= ? AND substr(date,1,10) <= ?', [bid, f, t]);
  const rec = x => (x.status === 'paid' || x.status === 'partial') ? (+x.paid || 0) : 0;
  const fat = txs.reduce((s, x) => s + rec(x), 0);
  const done = apts.filter(a => a.status === 'completed');
  const bySvc = {}, byStf = {}, byPay = {}, byHour = {};
  done.forEach(a => {
    bySvc[a.service_name] = bySvc[a.service_name] || { q: 0, v: 0 };
    bySvc[a.service_name].q++; bySvc[a.service_name].v += +a.price || 0;
    byStf[a.staff_name] = (byStf[a.staff_name] || 0) + 1;
    const h = String(a.time || '').slice(0, 2) + 'h';
    byHour[h] = (byHour[h] || 0) + 1;
  });
  txs.filter(x => ['paid', 'partial'].includes(x.status)).forEach(x => { byPay[x.method] = (byPay[x.method] || 0) + (+x.paid || 0); });
  const ids = {};
  apts.forEach(a => { if (a.client_id) ids[a.client_id] = (ids[a.client_id] || 0) + 1; });
  res.json({
    faturamento: fat, transacoes: txs.length, agendamentos: apts.length,
    concluidos: done.length,
    cancelados: apts.filter(a => a.status === 'cancelled').length,
    faltas: apts.filter(a => a.status === 'noshow').length,
    pendentes: apts.filter(a => a.status === 'pending').length,
    recorrentes: Object.values(ids).filter(q => q > 1).length,
    topServicos: Object.keys(bySvc).map(k => ({ name: k, q: bySvc[k].q, v: bySvc[k].v })).sort((a, b) => b.q - a.q).slice(0, 10),
    topProfissionais: Object.keys(byStf).map(k => ({ name: k, q: byStf[k] })).sort((a, b) => b.q - a.q).slice(0, 10),
    formasPagamento: byPay, horariosPico: byHour
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ================= LEMBRETES AUTOMÁTICOS (Web Push) =================
   A cada 45s, percorre agendamentos CONFIRMADOS e envia lembrete real
   ~24h e ~1h antes do horário (uma única vez cada, via flags no banco). */
function checkReminders() {
  const now = Date.now();
  const todos = all("SELECT a.*, b.slug AS bslug FROM appointments a JOIN businesses b ON b.id = a.business_id WHERE a.status = 'confirmed' AND (a.remind_24h_sent = 0 OR a.remind_1h_sent = 0)");
  for (const a of todos) {
    const d = new Date(a.date + 'T' + a.time);
    if (isNaN(d)) continue;
    const diffMin = (d.getTime() - now) / 60000;
    if (diffMin < 0) continue;
    const url = '/agendamento.html?b=' + a.bslug;
    if (!a.remind_24h_sent && diffMin >= 23 * 60 && diffMin <= 25 * 60) {
      push.sendToClient(a.business_id, { clientId: a.client_id, phone: a.phone }, {
        title: '⏰ Lembrete: seu horário é amanhã',
        body: `Olá ${a.client_name}! Seu ${a.service_name} está marcado para amanhã às ${a.time}. Qualquer mudança, fale com a gente.`,
        url,
        ttl: 86400
      }).then(n => { if (n > 0) run('UPDATE appointments SET remind_24h_sent = 1 WHERE id = ?', [a.id]); }).catch(() => {});
    } else if (!a.remind_1h_sent && diffMin >= 50 && diffMin <= 70) {
      push.sendToClient(a.business_id, { clientId: a.client_id, phone: a.phone }, {
        title: '🔔 Em 1 hora é sua vez!',
        body: `Olá ${a.client_name}! Seu ${a.service_name} é às ${a.time}. Estamos te esperando.`,
        url,
        ttl: 86400
      }).then(n => { if (n > 0) run('UPDATE appointments SET remind_1h_sent = 1 WHERE id = ?', [a.id]); }).catch(() => {});
    }
  }
}
checkReminders();
setInterval(checkReminders, 45 * 1000);
checkSubscriptions();
setInterval(checkSubscriptions, 60 * 1000);

const https = require('https');

const PUBLIC_DIR = path.join(__dirname, '..');
app.use((req, res, next) => {
  if (req.path.startsWith('/backend') || req.path.endsWith('.db') || req.path.includes('node_modules')) return res.status(404).end();
  next();
});
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    if (/\.(html|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// Suporte a HTTPS nativo para produção, caso não use reverse proxy (ex: Nginx)
if (process.env.SSL_KEY && process.env.SSL_CERT) {
  const options = {
    key: fs.readFileSync(process.env.SSL_KEY),
    cert: fs.readFileSync(process.env.SSL_CERT)
  };
  https.createServer(options, app).listen(PORT, () => {
    console.log(`AgendIt backend no ar (HTTPS): https://agendit.com.br`);
  });
} else {
  app.listen(PORT, () => console.log(`AgendIt backend no ar (HTTP): http://agendit.com.br`));
}
