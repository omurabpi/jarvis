// Trasferimento di Jarvis tra dispositivi (PC -> iPhone e viceversa) senza server:
// tutti i dati "jarvis.*" vengono compressi in un codice da copiare e incollare nell'altro dispositivo.
// Su iPhone l'app sulla Home ha una memoria separata da Safari: per questo si incolla il codice
// dentro l'app invece di aprire un link.

const PREFIX = "JARVIS1.";
const SKIP = new Set(["models", "installDismissed", "github"]); // cache rigenerabili o preferenze del singolo dispositivo
const MAX_CHAT = 300;

export function readAll() {
  const data = {};
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith("jarvis.")) continue;
    const key = k.slice(7);
    if (SKIP.has(key)) continue;
    try { data[key] = JSON.parse(localStorage.getItem(k)); } catch {}
  }
  return data;
}
const write = (key, value) => localStorage.setItem("jarvis." + key, JSON.stringify(value));

const toB64url = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function exportCode(includeKeys) {
  const data = readAll();
  if (data.settings && !includeKeys) data.settings = { ...data.settings, keys: {} };
  const stream = new Blob([JSON.stringify({ v: 1, data })]).stream().pipeThrough(new CompressionStream("gzip"));
  return PREFIX + toB64url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function decode(code) {
  const raw = String(code).replace(/\s+/g, "");
  const at = raw.indexOf(PREFIX);
  if (at < 0) throw new Error("Questo non sembra un codice di Jarvis.");
  const stream = new Blob([fromB64url(raw.slice(at + PREFIX.length))]).stream().pipeThrough(new DecompressionStream("gzip"));
  const parsed = JSON.parse(await new Response(stream).text());
  if (!parsed?.data) throw new Error("Codice incompleto: ricopialo per intero.");
  return parsed.data;
}

const sameText = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

// Unisce i dati ricevuti con quelli già presenti, senza doppioni.
export function merge(local, incoming) {
  const out = { ...local };
  for (const [key, value] of Object.entries(incoming)) {
    const mine = local[key];
    if (mine === undefined || mine === null) { out[key] = value; continue; }
    if (key === "settings") {
      // Restano le impostazioni di questo dispositivo; si aggiungono le chiavi che qui mancano.
      out.settings = { ...value, ...mine, keys: { ...(value.keys || {}), ...(mine.keys || {}) }, models: { ...(value.models || {}), ...(mine.models || {}) } };
    } else if (key === "chat" && Array.isArray(mine) && Array.isArray(value)) {
      const seen = new Set(mine.map((m) => `${m.ts}|${m.role}|${String(m.text).slice(0, 40)}`));
      out.chat = [...mine, ...value.filter((m) => !seen.has(`${m.ts}|${m.role}|${String(m.text).slice(0, 40)}`))]
        .sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-MAX_CHAT);
    } else if (key === "memory" && Array.isArray(mine) && Array.isArray(value)) {
      out.memory = [...mine, ...value.filter((m) => !mine.some((x) => x.id === m.id || sameText(x.text, m.text)))];
    } else if (Array.isArray(mine) && Array.isArray(value)) {
      // Promemoria, rubrica e altre liste: unione per id (o per contenuto).
      const has = (x) => mine.some((m) => (x?.id && m?.id === x.id) || JSON.stringify(m) === JSON.stringify(x));
      out[key] = [...mine, ...value.filter((x) => !has(x))];
    } else if (key === "learnedUntil") {
      out[key] = Math.max(Number(mine) || 0, Number(value) || 0);
    }
    // Altri valori (aperture, legame...): resta quello di questo dispositivo.
  }
  return out;
}

export async function importCode(code) {
  const incoming = await decode(code);
  const merged = merge(readAll(), incoming);
  for (const [k, v] of Object.entries(merged)) write(k, v);
  return {
    messages: incoming.chat?.length || 0,
    memories: incoming.memory?.length || 0,
    hasKey: !!Object.values(merged.settings?.keys || {}).some(Boolean),
  };
}

// ---------- Interfaccia (aggiunta da qui per non toccare index.html) ----------
function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }

async function pasteInto(textarea) {
  try { textarea.value = await navigator.clipboard.readText(); } catch { textarea.focus(); }
}

function importPanel({ toast, onDone }) {
  const box = el(`<div class="transfer-in" style="display:grid;gap:10px">
    <p class="small muted" style="margin:0">Sul dispositivo dove usi già Jarvis apri <strong>Impostazioni → Trasferisci su un altro dispositivo</strong>, copia il codice e mandatelo (WhatsApp, email, Note). Poi incollalo qui.</p>
    <textarea rows="3" placeholder="Incolla qui il codice JARVIS1…" spellcheck="false" style="font-size:.8rem"></textarea>
    <div style="display:flex;gap:8px"><button type="button" class="ghost" data-paste style="flex:1">Incolla</button><button type="button" class="primary" data-import style="flex:2">Importa i miei dati</button></div>
    <p class="small" data-msg hidden></p>
  </div>`);
  const ta = box.querySelector("textarea"), msg = box.querySelector("[data-msg]");
  box.querySelector("[data-paste]").onclick = () => pasteInto(ta);
  box.querySelector("[data-import]").onclick = async () => {
    msg.hidden = false; msg.className = "small muted"; msg.textContent = "Importo…";
    try {
      const r = await importCode(ta.value);
      msg.className = "small"; msg.textContent = `Fatto: ${r.messages} messaggi e ${r.memories} ricordi. Riavvio Jarvis…`;
      toast?.("Bentornato su questo dispositivo.");
      setTimeout(() => onDone ? onDone(r) : location.reload(), 900);
    } catch (err) {
      msg.className = "small error"; msg.textContent = err.message || "Codice non valido.";
    }
  };
  return box;
}

export function initTransfer({ toast } = {}) {
  // Impostazioni: invia e ricevi.
  const danger = document.querySelector("#sheet-settings .danger-zone");
  if (danger && !document.querySelector("#transfer-guide")) {
    const details = el(`<details class="guide" id="transfer-guide">
      <summary>Trasferisci su un altro dispositivo</summary>
      <p class="small muted">Porta chat, memoria, promemoria e impostazioni sul telefono o sul PC: copia il codice, mandatelo e incollalo nell'altro Jarvis.</p>
      <label class="check" style="margin:8px 0"><input type="checkbox" data-keys checked> <span>Includi le chiavi API (non dovrai reinserirle)</span></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="primary" data-copy style="flex:1">Copia codice</button><button type="button" class="ghost" data-share style="flex:1">Condividi</button></div>
      <p class="small muted" data-info style="margin-top:8px">Il codice contiene le chiavi se la casella è attiva: mandalo solo a te stesso.</p>
      <h4>Ricevi da un altro dispositivo</h4>
    </details>`);
    details.append(importPanel({ toast }));
    const keys = details.querySelector("[data-keys]"), info = details.querySelector("[data-info]");
    keys.onchange = () => (info.textContent = keys.checked ? "Il codice contiene le chiavi: mandalo solo a te stesso." : "Senza chiavi: sull'altro dispositivo dovrai reinserirle.");
    details.querySelector("[data-copy]").onclick = async () => {
      const code = await exportCode(keys.checked);
      try { await navigator.clipboard.writeText(code); toast?.(`Codice copiato (${Math.round(code.length / 1024)} KB). Incollalo nell'altro Jarvis.`); }
      catch { toast?.("Non riesco a copiare: usa Condividi."); }
    };
    const shareBtn = details.querySelector("[data-share]");
    if (!navigator.share) shareBtn.hidden = true;
    shareBtn.onclick = async () => { try { await navigator.share({ text: await exportCode(keys.checked) }); } catch {} };
    danger.before(details);
  }

  // Primo avvio: "Hai già Jarvis su un altro dispositivo?"
  const nameStep = document.querySelector('.ob-step[data-step="name"]');
  if (nameStep && !document.querySelector("#ob-transfer")) {
    const wrap = el(`<div id="ob-transfer" style="display:grid;gap:10px;margin-top:6px">
      <button type="button" class="ghost wide" data-open>Hai già Jarvis su un altro dispositivo? Importa i tuoi dati</button>
    </div>`);
    const panel = importPanel({ toast });
    panel.hidden = true;
    wrap.append(panel);
    wrap.querySelector("[data-open]").onclick = (e) => { panel.hidden = !panel.hidden; e.currentTarget.hidden = true; panel.querySelector("textarea").focus(); };
    nameStep.append(wrap);
  }
}
