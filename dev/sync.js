// Account e sincronizzazione con GitHub.
// Ogni utente accede con il proprio GitHub (token con il solo permesso "gist"): i suoi dati Jarvis
// vengono salvati in un gist segreto del suo account, cifrati con AES-GCM. La chiave di cifratura
// deriva dal token, quindi chi vede solo il gist non può leggerlo.
// La sincronizzazione unisce (non sostituisce): niente si perde passando da un dispositivo all'altro.

import { readAll, merge } from "./transfer.js";

const API = "https://api.github.com";
const FILE = "jarvis.json";
const DESCRIPTION = "Jarvis: dati sincronizzati (cifrati)";
const TOKEN_URL = "https://github.com/settings/tokens/new?scopes=gist&description=Jarvis";

const getAccount = () => { try { return JSON.parse(localStorage.getItem("jarvis.github")) || null; } catch { return null; } };
const setAccount = (a) => (a ? localStorage.setItem("jarvis.github", JSON.stringify(a)) : localStorage.removeItem("jarvis.github"));

async function gh(token, path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(init.headers || {}) },
  });
  if (res.status === 401) throw new Error("Il token GitHub non è valido o è scaduto: ricollega l'account.");
  if (res.status === 403 || res.status === 404) {
    const detail = (await res.json().catch(() => ({}))).message || "";
    throw new Error(/scope|permission|Resource not accessible/i.test(detail) ? "Il token non ha il permesso \"gist\": creane uno nuovo dal link." : "GitHub: " + (detail || res.status));
  }
  if (!res.ok) throw new Error("GitHub non risponde (" + res.status + "). Riprovo più tardi.");
  return res.status === 204 ? null : res.json();
}

// ---------- Cifratura ----------
const enc = new TextEncoder();
const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function cryptoKey(token, login) {
  const base = await crypto.subtle.importKey("raw", enc.encode(token), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("jarvis-sync-v1|" + login), iterations: 150000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function seal(data, account) {
  const gz = await new Response(new Blob([JSON.stringify(data)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(account.token, account.login), gz);
  return JSON.stringify({ v: 1, iv: b64(iv), data: b64(new Uint8Array(ct)), updated: new Date().toISOString() });
}

async function open(text, account) {
  const box = JSON.parse(text);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, await cryptoKey(account.token, account.login), unb64(box.data));
  return JSON.parse(await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
}

// ---------- Collegamento e sincronizzazione ----------
const syncable = () => { const d = readAll(); delete d.github; return d; };

export async function connect(token) {
  token = token.trim();
  const user = await gh(token, "/user");
  let gistId = null;
  for (let page = 1; page <= 5 && !gistId; page++) {
    const list = await gh(token, `/gists?per_page=100&page=${page}`);
    gistId = list.find((g) => g.description === DESCRIPTION && g.files?.[FILE])?.id || null;
    if (list.length < 100) break;
  }
  const account = { token, login: user.login, avatar: user.avatar_url, gistId, lastSync: 0 };
  if (!gistId) {
    const created = await gh(token, "/gists", { method: "POST", body: JSON.stringify({ description: DESCRIPTION, public: false, files: { [FILE]: { content: await seal(syncable(), account) } } }) });
    account.gistId = created.id;
  }
  setAccount(account);
  return syncNow({ force: true });
}

export function disconnect() { setAccount(null); }

let syncing = null;
// Scarica, unisce con i dati locali, salva in locale e ricarica online. Ritorna se sono arrivati dati nuovi.
export function syncNow() {
  if (syncing) return syncing;
  syncing = (async () => {
    const account = getAccount();
    if (!account?.gistId) return { changed: false };
    const gist = await gh(account.token, `/gists/${account.gistId}`);
    const file = gist.files?.[FILE];
    let content = file?.content || "";
    if (file?.truncated && file.raw_url) content = await (await fetch(file.raw_url)).text();
    const local = syncable();
    let remote = {};
    if (content) { try { remote = await open(content, account); } catch { throw new Error("Non riesco a decifrare i dati online: il token è di un altro account?"); } }
    const merged = merge(local, remote);
    const changed = JSON.stringify(merged) !== JSON.stringify(local);
    writing = true;
    for (const [k, v] of Object.entries(merged)) localStorage.setItem("jarvis." + k, JSON.stringify(v));
    writing = false;
    await gh(account.token, `/gists/${account.gistId}`, { method: "PATCH", body: JSON.stringify({ files: { [FILE]: { content: await seal(merged, account) } } }) });
    setAccount({ ...getAccount(), lastSync: Date.now() });
    return { changed };
  })().finally(() => { syncing = null; });
  return syncing;
}

// Ogni scrittura di dati Jarvis programma una sincronizzazione (senza toccare il resto dell'app).
let writing = false, timer = 0;
function watchWrites() {
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    original.call(this, k, v);
    if (!writing && this === localStorage && String(k).startsWith("jarvis.") && k !== "jarvis.github" && getAccount()) {
      clearTimeout(timer);
      timer = setTimeout(() => syncNow().catch((e) => console.warn("Sincronizzazione rimandata:", e.message)), 8000);
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && getAccount()) syncNow().catch(() => {});
  });
}

// ---------- Interfaccia (aggiunta da qui per non toccare index.html) ----------
function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
const ago = (ts) => !ts ? "mai" : new Date(ts).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function loginForm({ toast, onConnected }) {
  const box = el(`<div style="display:grid;gap:10px">
    <ol class="small muted" style="margin:0;padding-left:20px;display:grid;gap:4px">
      <li>Se non hai GitHub, crealo gratis su <a href="https://github.com/signup" target="_blank" rel="noopener">github.com/signup</a></li>
      <li>Apri <a href="${TOKEN_URL}" target="_blank" rel="noopener"><strong>questa pagina</strong></a>: è già tutto compilato</li>
      <li>In "Expiration" scegli <strong>No expiration</strong>, poi in fondo <strong>Generate token</strong></li>
      <li>Copia il token (inizia con <code>ghp_</code>) e incollalo qui</li>
    </ol>
    <input type="password" placeholder="Incolla il token GitHub" autocomplete="off" spellcheck="false">
    <div style="display:flex;gap:8px"><button type="button" class="ghost" data-paste style="flex:1">Incolla</button><button type="button" class="primary" data-go style="flex:2">Collega GitHub</button></div>
    <p class="small" data-msg hidden></p>
  </div>`);
  const input = box.querySelector("input"), msg = box.querySelector("[data-msg]");
  box.querySelector("[data-paste]").onclick = async () => { try { input.value = (await navigator.clipboard.readText()).trim(); } catch { input.focus(); } };
  box.querySelector("[data-go]").onclick = async () => {
    msg.hidden = false; msg.className = "small muted"; msg.textContent = "Mi collego a GitHub e unisco i dati…";
    try {
      const { changed } = await connect(input.value);
      const acc = getAccount();
      msg.className = "small"; msg.textContent = `Collegato come @${acc.login}. ${changed ? "Ho recuperato i tuoi dati." : "Dati salvati online."}`;
      toast?.(`Account GitHub @${acc.login} collegato.`);
      onConnected?.(changed);
    } catch (err) {
      msg.className = "small error"; msg.textContent = err.message;
    }
  };
  return box;
}

function renderSettings(details, toast) {
  const acc = getAccount();
  const body = details.querySelector("[data-body]");
  body.innerHTML = "";
  if (!acc) {
    body.append(el(`<p class="small muted">Accedi con GitHub per salvare chat, memoria, promemoria e impostazioni in modo cifrato e ritrovarli su ogni dispositivo.</p>`));
    body.append(loginForm({ toast, onConnected: () => setTimeout(() => location.reload(), 900) }));
    return;
  }
  const info = el(`<div style="display:grid;gap:10px">
    <p class="small" style="margin:0">Collegato come <strong>@${acc.login}</strong>. Ultima sincronizzazione: <span data-last>${ago(acc.lastSync)}</span>.</p>
    <div style="display:flex;gap:8px"><button type="button" class="primary" data-sync style="flex:1">Sincronizza ora</button><button type="button" class="ghost danger" data-out style="flex:1">Scollega</button></div>
  </div>`);
  info.querySelector("[data-sync]").onclick = async () => {
    try { const { changed } = await syncNow(); toast?.(changed ? "Dati aggiornati dall'altro dispositivo." : "Tutto sincronizzato."); if (changed) setTimeout(() => location.reload(), 800); }
    catch (err) { toast?.(err.message); }
    info.querySelector("[data-last]").textContent = ago(getAccount()?.lastSync);
  };
  info.querySelector("[data-out]").onclick = () => { disconnect(); renderSettings(details, toast); toast?.("Account scollegato: i dati restano su questo dispositivo."); };
  body.append(info);
}

export function initSync({ toast } = {}) {
  watchWrites();

  const header = document.querySelector("#sheet-settings > header");
  if (header && !document.querySelector("#sync-guide")) {
    const details = el(`<details class="guide" id="sync-guide" open><summary>Account e sincronizzazione</summary><div data-body style="margin-top:10px"></div></details>`);
    renderSettings(details, toast);
    header.after(details); // in cima alle impostazioni: è la prima cosa da fare su un nuovo dispositivo
    document.querySelector('[data-open="settings"]')?.addEventListener("click", () => renderSettings(details, toast));
  }

  const nameStep = document.querySelector('.ob-step[data-step="name"]');
  if (nameStep && !document.querySelector("#ob-github")) {
    const wrap = el(`<div id="ob-github" style="display:grid;gap:10px;margin-top:6px"><button type="button" class="ghost wide" data-open>Hai già un account Jarvis? Accedi con GitHub</button></div>`);
    const form = loginForm({ toast, onConnected: () => setTimeout(() => location.reload(), 900) });
    form.hidden = true;
    wrap.append(form);
    wrap.querySelector("[data-open]").onclick = (e) => { form.hidden = false; e.currentTarget.hidden = true; form.querySelector("input").focus(); };
    nameStep.append(wrap);
  }

  // All'apertura: se l'account è collegato, unisce i dati online; se ne arrivano di nuovi ricarica una volta.
  if (getAccount()) {
    syncNow().then(({ changed }) => {
      if (changed && !sessionStorage.getItem("jarvis.syncReloaded")) {
        sessionStorage.setItem("jarvis.syncReloaded", "1");
        location.reload();
      }
    }).catch((err) => console.warn("Sincronizzazione all'avvio non riuscita:", err.message));
  }
}
