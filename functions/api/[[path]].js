import { route, d1Store, init } from "../_lib.js";

export async function onRequestPost({ request, env }) {
  const json = (s, o) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  let b = {};
  try { b = JSON.parse((await request.text()) || "{}"); } catch { return json(400, { error: "bad json" }); }
  try {
    if (!env.DB) return json(500, { error: "Falta conectar la base de datos D1 (variable DB)" });
    await init(env.DB);
    const [s, o] = await route(new URL(request.url).pathname, b, d1Store(env.DB), env.ADMIN_KEY);
    return json(s, o);
  } catch (e) { return json(500, { error: e.message || "Error del servidor" }); }
}
export const onRequest = () => new Response(JSON.stringify({ error: "method" }), { status: 405, headers: { "Content-Type": "application/json" } });
