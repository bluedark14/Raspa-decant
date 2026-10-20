// Raspa y Gana – lógica compartida (Cloudflare Pages Functions + D1)

/* ===== PREMIOS (weight = probabilidad relativa) ===== */
export const PRIZES = [
  { emoji: "🏷️", text: "5% de descuento",       weight: 60, image: "/premio-5.jpg" },
  { emoji: "💎", text: "10% de descuento",      weight: 30, image: "/premio-10.jpg" },
  { emoji: "🧴", text: "Decant de 2 ml gratis", weight: 10, buyerOnly: true, image: "/premio-2ml.jpg" },  // solo tarjetas "con compra"
];
/* ==================================================== */

// type: "compra" (cliente que compró: todos los premios) o "visita" (sin compra: solo descuentos)
const pickPrize = (type) => {
  const pool = PRIZES.filter(p => type !== "visita" || !p.buyerOnly);
  const total = pool.reduce((s, p) => s + p.weight, 0);
  let r = rnd32() / 2 ** 32 * total;
  for (const p of pool) if ((r -= p.weight) < 0) return p;
  return pool[0];
};
const rnd32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => ALPHA[b % ALPHA.length]).join("");
const clean = t => String(t || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
const isAdmin = (key, adminKey) => {
  const a = new TextEncoder().encode(String(key || "")), b = new TextEncoder().encode(String(adminKey || ""));
  if (!adminKey || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
};

// Actualiza un ticket de forma segura aunque lleguen dos peticiones a la vez
async function update(store, key, fn) {
  for (let i = 0; i < 6; i++) {
    const r = await store.getWithMetadata(key, { type: "json" });
    if (!r) return null;
    const next = fn(r.data);
    if (next === r.data) return r.data;
    const w = await store.set(key, JSON.stringify(next), { onlyIfMatch: r.etag });
    if (!w || w.modified !== false) return next;
  }
  throw new Error("Intenta de nuevo");
}
async function inChunks(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

export async function route(path, b, store, adminKey) {
  const t = clean(b.t);
  const dev = String(b.d || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 48);

  // ---- Cliente ----
  if (path === "/api/open") {
    if (!t) return [200, { demo: true, prize: pickPrize("visita") }];            // modo prueba, no se guarda
    // El primer dispositivo que abre el código lo "reclama": nadie más puede abrirlo (aunque tenga el link o una foto del QR)
    let locked = false;
    const k = await update(store, t, k => {
      if (k.device && k.device !== dev) { locked = true; return k; }
      if (k.prize && (k.device || !dev)) return k;
      const next = { ...k };
      if (!next.prize) { next.prize = pickPrize(k.type); next.openedAt = Date.now(); }
      if (!next.device && dev) next.device = dev;
      return next;
    });
    if (!k) return [404, { error: "invalid" }];
    if (locked) return [403, { error: "locked", openedAt: k.openedAt || null }];
    return [200, { type: k.type || "compra", prize: k.prize, revealed: !!k.revealedAt, redeemed: !!k.redeemedAt, review: k.review ? { stars: k.review.stars } : null }];
  }
  if (path === "/api/reveal") {
    const cur = await store.get(t, { type: "json" });
    if (cur && cur.device && cur.device !== dev) return [403, { error: "locked" }];
    const k = await update(store, t, k => !k.prize || k.revealedAt ? k : { ...k, revealedAt: Date.now() });
    if (!k || !k.prize) return [404, { error: "invalid" }];
    return [200, { ok: true }];
  }

  if (path === "/api/review") {
    const stars = parseInt(b.stars);
    if (!(stars >= 1 && stars <= 5)) return [400, { error: "Elige de 1 a 5 estrellas" }];
    const comment = String(b.comment || "").replace(/\s+/g, " ").trim().slice(0, 300);
    let state = "ok";
    const cur = await store.get(t, { type: "json" });
    if (cur && cur.device && cur.device !== dev) return [403, { error: "locked" }];
    const k = await update(store, t, k => {
      if (!k.revealedAt) { state = "noplay"; return k; }
      if (k.review) { state = "dup"; return k; }
      return { ...k, review: { stars, comment, at: Date.now() } };
    });
    if (!k) return [404, { error: "invalid" }];
    if (state === "noplay") return [400, { error: "Primero raspa tu tarjeta" }];
    if (state === "dup") return [400, { error: "Ya enviaste tu reseña. ¡Gracias!" }];
    return [200, { ok: true }];
  }

  // ---- Administrador ----
  if (!path.startsWith("/api/admin/")) return [404, { error: "not found" }];
  if (!isAdmin(b.key, adminKey)) return [401, { error: "Contraseña incorrecta" }];

  if (path === "/api/admin/generate") {
    const n = Math.max(1, Math.min(500, parseInt(b.n) || 1)), codes = [];
    const type = b.type === "visita" ? "visita" : "compra";
    const channel = b.channel === "digital" ? "digital" : "print";
    while (codes.length < n) {
      const batch = Array.from({ length: Math.min(50, n - codes.length) }, newCode);
      const res = await Promise.all(batch.map(c => store.set(c, JSON.stringify({ createdAt: Date.now(), type, channel }), { onlyIfNew: true })));
      res.forEach((r, i) => { if (!r || r.modified !== false) codes.push(batch[i]); });
    }
    return [200, { codes }];
  }
  if (path === "/api/admin/lookup") {
    const k = await store.get(t, { type: "json" });
    if (!k) return [404, { error: "Código no existe" }];
    return [200, { code: t, type: k.type || "compra", channel: k.channel || "print", sentTo: k.sentTo || "", sentAt: k.sentAt || null, openedAt: k.openedAt || null, bound: !!k.device, prize: k.prize || null, revealed: !!k.revealedAt, redeemed: !!k.redeemedAt }];
  }
  if (path === "/api/admin/redeem") {
    const cur = await store.get(t, { type: "json" });
    if (!cur) return [404, { error: "Código no existe" }];
    if (!cur.revealedAt) return [400, { error: "Este código aún no ha sido raspado" }];
    let already = false;
    const k = await update(store, t, k => { if (k.redeemedAt) { already = true; return k; } return { ...k, redeemedAt: Date.now() }; });
    if (already) return [400, { error: "Este premio YA fue canjeado" }];
    return [200, { ok: true, prize: k.prize }];
  }
  // Libera un código que quedó ligado a un celular (por si el cliente cambió de teléfono o navegador)
  if (path === "/api/admin/release") {
    const k = await update(store, t, k => k.device ? (({ device, ...rest }) => rest)(k) : k);
    if (!k) return [404, { error: "Código no existe" }];
    return [200, { ok: true }];
  }
  // Marca un link digital como enviado; si ya se había enviado (o ya se jugó) avisa en vez de repetirlo
  if (path === "/api/admin/send") {
    let conflict = null;
    const k = await update(store, t, k => {
      if (!b.force && (k.sentAt || k.openedAt)) { conflict = k; return k; }
      return { ...k, sentAt: Date.now(), sentTo: String(b.to || "").slice(0, 60), resends: k.sentAt ? (k.resends || 0) + 1 : (k.resends || 0) };
    });
    if (!k) return [404, { error: "Código no existe" }];
    if (conflict) return [409, { error: "already_sent", sentTo: conflict.sentTo || "", sentAt: conflict.sentAt || null, opened: !!conflict.openedAt }];
    return [200, { ok: true }];
  }
  // Lista de links digitales: "pending" = sin enviar y sin jugar (el más viejo primero), "sent" = ya enviados
  if (path === "/api/admin/list") {
    const status = b.status === "sent" ? "sent" : "pending";
    const all = await store.all();
    let items = all.filter(k => k && k.channel === "digital" && (!b.type || (k.type || "compra") === b.type));
    items = status === "sent" ? items.filter(k => k.sentAt).sort((a, c) => c.sentAt - a.sentAt)
                              : items.filter(k => !k.sentAt && !k.openedAt).sort((a, c) => a.createdAt - c.createdAt);
    return [200, { items: items.slice(0, 200).map(k => ({ code: k.code, type: k.type || "compra", sentAt: k.sentAt || null, sentTo: k.sentTo || "", opened: !!k.openedAt, played: !!k.revealedAt, redeemed: !!k.redeemedAt })) }];
  }
  if (path === "/api/admin/stats") {
    const all = (await store.all()).map(k => k);
    const out = { total: all.length, played: 0, redeemed: 0, byPrize: {}, opened: 0, reviews: 0, avg: 0, comments: [], byType: { compra: 0, visita: 0 }, digital: { total: 0, sent: 0, pending: 0 } };
    let sum = 0;
    for (const k of all) {
      if (!k) continue;
      out.byType[k.type === "visita" ? "visita" : "compra"]++;
      if (k.channel === "digital") { out.digital.total++; if (k.sentAt) out.digital.sent++; else if (!k.openedAt) out.digital.pending++; }
      if (k.revealedAt) { out.played++; out.byPrize[k.prize.text] = (out.byPrize[k.prize.text] || 0) + 1; }
      if (k.openedAt) out.opened++;
      if (k.redeemedAt) out.redeemed++;
      if (k.review) { out.reviews++; sum += k.review.stars; if (k.review.comment) out.comments.push({ stars: k.review.stars, comment: k.review.comment, at: k.review.at }); }
    }
    out.avg = out.reviews ? Math.round(sum / out.reviews * 10) / 10 : 0;
    out.comments = out.comments.sort((a, b) => b.at - a.at).slice(0, 15);
    return [200, out];
  }
  return [404, { error: "not found" }];
}


/* ===== Almacén D1 (SQLite de Cloudflare) con candado optimista ===== */
let ready;
async function init(db) {
  ready ||= db.exec("CREATE TABLE IF NOT EXISTS tickets (code TEXT PRIMARY KEY, data TEXT NOT NULL, ver INTEGER NOT NULL DEFAULT 0)");
  await ready;
}
export function d1Store(db) {
  const changed = r => (r.meta?.changes ?? r.changes ?? 0) > 0;
  return {
    async get(k) { const r = await db.prepare("SELECT data FROM tickets WHERE code=?").bind(k).first(); return r ? JSON.parse(r.data) : null; },
    async getWithMetadata(k) { const r = await db.prepare("SELECT data, ver FROM tickets WHERE code=?").bind(k).first(); return r ? { data: JSON.parse(r.data), etag: r.ver } : null; },
    async set(k, v, o = {}) {
      if (o.onlyIfNew) { const r = await db.prepare("INSERT OR IGNORE INTO tickets (code,data,ver) VALUES (?,?,0)").bind(k, v).run(); return { modified: changed(r) }; }
      if ("onlyIfMatch" in o) { const r = await db.prepare("UPDATE tickets SET data=?, ver=ver+1 WHERE code=? AND ver=?").bind(v, k, o.onlyIfMatch).run(); return { modified: changed(r) }; }
      await db.prepare("INSERT INTO tickets (code,data,ver) VALUES (?,?,0) ON CONFLICT(code) DO UPDATE SET data=excluded.data, ver=ver+1").bind(k, v).run();
      return { modified: true };
    },
    async all() { const { results } = await db.prepare("SELECT code, data FROM tickets").all(); return results.map(r => ({ code: r.code, ...JSON.parse(r.data) })); },
  };
}
export { init };
