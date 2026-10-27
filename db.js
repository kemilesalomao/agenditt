// AgendIt — banco de dados real (SQLite via node:sqlite, arquivo agendit.db)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'agendit.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  segment TEXT DEFAULT 'outro',
  phone TEXT DEFAULT '',
  whatsapp TEXT DEFAULT '',
  address TEXT DEFAULT '',
  description TEXT DEFAULT '',
  instagram TEXT DEFAULT '',
  logo TEXT DEFAULT '',
  plan TEXT DEFAULT 'Profissional',
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  duration_min INTEGER NOT NULL DEFAULT 30,
  price REAL NOT NULL DEFAULT 0,
  category TEXT DEFAULT 'Geral',
  image TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_staff (
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  PRIMARY KEY (service_id, staff_id)
);
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  specialty TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  start_time TEXT DEFAULT '09:00',
  end_time TEXT DEFAULT '19:00',
  interval_min INTEGER DEFAULT 15,
  active INTEGER NOT NULL DEFAULT 1,
  avatar TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_days (
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL,
  PRIMARY KEY (staff_id, weekday)
);
CREATE TABLE IF NOT EXISTS staff_timeoff (
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  PRIMARY KEY (staff_id, date)
);
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT DEFAULT '',
  birth TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clients_biz ON clients(business_id);
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  client_name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  service_name TEXT NOT NULL,
  staff_id TEXT REFERENCES staff(id) ON DELETE SET NULL,
  staff_name TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  price REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'confirmed',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apt_biz_date ON appointments(business_id, date);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  appointment_id TEXT REFERENCES appointments(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  service_name TEXT NOT NULL,
  total REAL NOT NULL DEFAULT 0,
  paid REAL NOT NULL DEFAULT 0,
  remaining REAL NOT NULL DEFAULT 0,
  method TEXT DEFAULT 'Pix',
  status TEXT NOT NULL DEFAULT 'pending',
  date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS business_settings (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  hours_json TEXT NOT NULL DEFAULT '{}',
  rules_json TEXT NOT NULL DEFAULT '{}',
  cancel_json TEXT NOT NULL DEFAULT '{}',
  payments_json TEXT NOT NULL DEFAULT '{}',
  appearance_json TEXT NOT NULL DEFAULT '{}',
  notifprefs_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL DEFAULT 'all',
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  reason TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS master_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  phone TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_biz_client ON push_subscriptions(business_id, client_id);
CREATE INDEX IF NOT EXISTS idx_push_biz_phone ON push_subscriptions(business_id, phone);
CREATE TABLE IF NOT EXISTS subscriptions (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  kiwify_subscription_id TEXT DEFAULT '',
  plan_name TEXT DEFAULT 'Profissional',
  price_reais REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  last_renewal_at TEXT,
  paid_until TEXT,
  next_billing TEXT,
  cancel_requested_at TEXT,
  cancel_scheduled_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscription_payments (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id TEXT DEFAULT '',
  amount_reais REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'paid',
  channel TEXT DEFAULT 'Kiwify',
  paid_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subpay_biz ON subscription_payments(business_id);
CREATE TABLE IF NOT EXISTS subscription_events (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  detail TEXT DEFAULT '',
  actor TEXT DEFAULT 'kiwify',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subev_biz ON subscription_events(business_id);
`);

function ensureColumn(table, column, decl) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
  if (!cols.some(c => c.name === column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + decl);
}
ensureColumn('appointments', 'remind_24h_sent', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('appointments', 'remind_1h_sent', 'INTEGER NOT NULL DEFAULT 0');

function dropCol(table, column) { try { db.exec('ALTER TABLE ' + table + ' DROP COLUMN ' + column); } catch (e) {} }
dropCol('appointments', 'pay_method');
dropCol('appointments', 'pay_status');
dropCol('appointments', 'upfront_required');
dropCol('appointments', 'upfront_percent');
dropCol('appointments', 'upfront_amount');
dropCol('appointments', 'upfront_paid');
dropCol('appointments', 'upfront_paid_at');
dropCol('appointments', 'upfront_ref');
dropCol('transactions', 'kiwify_order_id');
ensureColumn('businesses', 'whatsapp', "TEXT DEFAULT ''");
ensureColumn('business_settings', 'chat_json', "TEXT DEFAULT '{}'");
try { db.exec('DROP TABLE IF EXISTS pay_events'); } catch (e) {}

function slugify(name) {
  return String(name || 'negocio').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'negocio';
}
function uniqueSlug(base) {
  let slug = slugify(base), i = 2;
  const exists = s => db.prepare('SELECT 1 FROM businesses WHERE slug = ?').get(s);
  while (exists(slug)) slug = slugify(base) + '-' + (i++);
  return slug;
}
const uid = p => (p || 'id') + '-' + Date.now().toString(36) + Math.floor(Math.random() * 9999);
const nowISO = () => new Date().toISOString();

module.exports = { db, slugify, uniqueSlug, uid, nowISO };
