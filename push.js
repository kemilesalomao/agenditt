// AgendIt — notificações Web Push reais (VAPID + web-push).
// Chaves VAPID persistidas em backend/vapid.json (geradas no 1º boot).
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const { db, uid, nowISO } = require('./db');

const VAPID_FILE = path.join(__dirname, 'vapid.json');
let vapid = null;

function ensureVapid() {
  if (vapid) return vapid;
  if (fs.existsSync(VAPID_FILE)) {
    try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); } catch {}
  }
  if (!vapid || !vapid.publicKey || !vapid.privateKey) {
    const keys = webpush.generateVAPIDKeys();
    vapid = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: process.env.VAPID_SUBJECT || 'mailto:contato@agendit.com.br'
    };
    fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2), 'utf8');
  }
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return vapid;
}

function init() { ensureVapid(); }
function getPublicKey() { return ensureVapid().publicKey; }

// Registra (ou atualiza) uma PushSubscription no banco, vinculada ao cliente.
function register({ businessId, clientId, phone, subscription }) {
  const sub = subscription || {};
  const keys = sub.keys || {};
  if (!sub.endpoint || !keys.p256dh || !keys.auth) throw new Error('Assinatura push inválida.');
  const sid = uid('push');
  const ts = nowISO();
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(sub.endpoint);
  if (existing) {
    db.prepare('UPDATE push_subscriptions SET business_id = ?, client_id = ?, phone = ?, p256dh = ?, auth = ?, updated_at = ? WHERE id = ?')
      .run(businessId, clientId || null, String(phone || '').trim(), keys.p256dh, keys.auth, ts, existing.id);
    return { registered: false, id: existing.id };
  }
  db.prepare('INSERT INTO push_subscriptions (id, business_id, client_id, phone, endpoint, p256dh, auth, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(sid, businessId, clientId || null, String(phone || '').trim(), sub.endpoint, keys.p256dh, keys.auth, ts, ts);
  return { registered: true, id: sid };
}

function unregister(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint || '');
}

// Envia payload real para as assinaturas do cliente (por client_id e/ou telefone).
function sendToClient(businessId, { clientId, phone }, payload) {
  let subs;
  if (clientId) {
    subs = db.prepare('SELECT * FROM push_subscriptions WHERE business_id = ? AND (client_id = ? OR phone = ?)').all(businessId, clientId, String(phone || ''));
  } else {
    subs = db.prepare('SELECT * FROM push_subscriptions WHERE business_id = ? AND phone = ?').all(businessId, String(phone || ''));
  }
  if (!subs.length) return Promise.resolve(0);
  let sent = 0;
  return Promise.allSettled(subs.map(s => {
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    return webpush.sendNotification(sub, JSON.stringify({
      title: payload.title || 'AgendIt',
      body: payload.body || '',
      url: payload.url || '/',
      icon: payload.icon || '/Logo_Agendit.jpg',
      badge: payload.badge || '/Agendit_logo-wt-nobg.png'
    }), { TTL: payload.ttl || 86400 })
      .then(() => { sent++; return sent; })
      .catch(e => {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) {
          try { db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint); } catch {}
        }
      });
  })).then(() => sent);
}

// Envia para as assinaturas atreladas a um agendamento (busca o cliente pelo appointment).
function sendToAppointment(businessId, appointmentId, payload) {
  const a = db.prepare('SELECT client_id, phone FROM appointments WHERE id = ? AND business_id = ?').get(appointmentId, businessId);
  if (!a) return Promise.resolve(0);
  return sendToClient(businessId, { clientId: a.client_id, phone: a.phone }, payload);
}

module.exports = { init, getPublicKey, register, unregister, sendToClient, sendToAppointment };