/**
 * AgendIt — API do Painel de Administrador Geral.
 * Usa o mesmo token de sessão (localStorage 'agendit_token').
 * Toda autorização é revalidada no backend (role = admin).
 */
const AdminApi = {
  get token() { try { return localStorage.getItem('agendit_token') || ''; } catch { return ''; } },
  set token(v) { try { v ? localStorage.setItem('agendit_token', v) : localStorage.removeItem('agendit_token'); } catch {} },
  logout() { this.token = ''; },
  async req(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, this.token ? { Authorization: 'Bearer ' + this.token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try { data = await r.json(); } catch {}
    if (r.status === 401) { this.logout(); if (!String(path).includes('/api/auth/')) window.location.replace('login.html'); }
    if (!r.ok) { const e = new Error((data && data.error) || ('Erro ' + r.status)); e.status = r.status; e.code = data && data.code; throw e; }
    return data;
  },
  me() { return this.req('GET', '/api/me'); },
  dashboard() { return this.req('GET', '/api/admin/dashboard'); },
  subscribers() { return this.req('GET', '/api/admin/subscribers'); },
  subscriber(id) { return this.req('GET', '/api/admin/subscribers/' + encodeURIComponent(id)); },
  suspend(id) { return this.req('POST', '/api/admin/subscribers/' + encodeURIComponent(id) + '/suspend'); },
  reactivate(id) { return this.req('POST', '/api/admin/subscribers/' + encodeURIComponent(id) + '/reactivate'); },
  cancelSubscription(id) { return this.req('POST', '/api/admin/subscribers/' + encodeURIComponent(id) + '/cancel'); },
  changePlan(id, plan) { return this.req('POST', '/api/admin/subscribers/' + encodeURIComponent(id) + '/plan', { plan }); },
  block(id) { return this.req('POST', '/api/admin/subscribers/' + encodeURIComponent(id) + '/block'); },
  unblock(id) { return this.req('POST', '/api/admin/subscribers/' + encodeURIComponent(id) + '/unblock'); },
  createUser(id, d) { return this.req('POST', '/api/admin/subscribers/' + encodeURIComponent(id) + '/users', d); },
  updateUser(uid, d) { return this.req('PUT', '/api/admin/users/' + encodeURIComponent(uid), d); },
  resetPassword(uid, password) { return this.req('POST', '/api/admin/users/' + encodeURIComponent(uid) + '/reset-password', { password }); },
  deleteUser(uid) { return this.req('DELETE', '/api/admin/users/' + encodeURIComponent(uid)); },
  businesses() { return this.req('GET', '/api/admin/businesses'); },
  config() { return this.req('GET', '/api/admin/config'); },
  saveConfig(d) { return this.req('PUT', '/api/admin/config', d); }
};
