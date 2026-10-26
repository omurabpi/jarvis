// Collegamento semiautomatico del calendario: Jarvis crea nel GitHub dell'utente un repository privato
// con la procedura che ogni 30 minuti legge il calendario (Google o Apple) e lo salva cifrato nel suo
// archivio Jarvis. Serve un permesso temporaneo (token con "repo" e "workflow") che NON viene salvato.

const API = "https://api.github.com";
const SODIUM_URL = "https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.15/+esm";
const REPO = "jarvis-calendario";
const SETUP_TOKEN_URL = "https://github.com/settings/tokens/new?scopes=repo,workflow&description=Jarvis%20collegamento%20calendario";
const FILES = [
  ["sync_calendario.py", "calendario/sync_calendario.py"],
  ["requirements.txt", "calendario/requirements.txt"],
  [".github/workflows/calendario.yml", "calendario/calendario.yml"],
];

async function gh(token, path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(init.headers || {}) },
  });
  if (res.status === 401) throw new Error("Il permesso temporaneo non è valido: creane uno nuovo dal link.");
  if (res.status === 403) throw new Error("Il permesso temporaneo non basta: quando lo crei lascia spuntati \"repo\" e \"workflow\".");
  if (!res.ok && res.status !== 404 && res.status !== 422) throw new Error(`GitHub ha risposto ${res.status}. Riprova tra poco.`);
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
}

const toB64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function sealSecret(publicKey, value) {
  const { default: sodium } = await import(SODIUM_URL);
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL));
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

// step(testo) viene chiamata a ogni passo per mostrare l'avanzamento.
export async function setupCalendar({ setupToken, calendarUrl, jarvisToken, step = () => {} }) {
  setupToken = setupToken.trim(); calendarUrl = calendarUrl.trim();
  if (!/^(webcal|https):\/\/\S+$/i.test(calendarUrl)) throw new Error("Il link del calendario non sembra valido: deve iniziare con https:// o webcal://");
  if (!jarvisToken) throw new Error("Collega prima Jarvis a GitHub (Impostazioni → Account e sincronizzazione).");

  step("Controllo il permesso…");
  const { body: user } = await gh(setupToken, "/user");
  const owner = user.login;

  step("Creo la tua procedura privata su GitHub…");
  const created = await gh(setupToken, "/user/repos", {
    method: "POST",
    body: JSON.stringify({ name: REPO, private: true, auto_init: true, description: "Jarvis: legge il calendario ogni 30 minuti (creato dall'app)" }),
  });
  if (created.status === 422) {
    const existing = await gh(setupToken, `/repos/${owner}/${REPO}`);
    if (existing.status !== 200) throw new Error(`Esiste già un repository "${REPO}" che non riesco ad aprire.`);
    if (!existing.body.private) throw new Error(`Hai già un repository pubblico "${REPO}": rinominalo o rendilo privato, poi riprova.`);
  }
  for (let i = 0; i < 10; i++) { if ((await gh(setupToken, `/repos/${owner}/${REPO}/branches/main`)).status === 200) break; await wait(1500); }

  step("Carico la procedura…");
  for (const [path, src] of FILES) {
    const content = await (await fetch(src, { cache: "no-store" })).text();
    const current = await gh(setupToken, `/repos/${owner}/${REPO}/contents/${path}`);
    await gh(setupToken, `/repos/${owner}/${REPO}/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({ message: "Procedura calendario Jarvis", content: toB64(content), ...(current.status === 200 ? { sha: current.body.sha } : {}) }),
    });
  }

  step("Inserisco i segreti cifrati…");
  const { body: key } = await gh(setupToken, `/repos/${owner}/${REPO}/actions/secrets/public-key`);
  for (const [name, value] of [["CALENDAR_URL", calendarUrl], ["JARVIS_TOKEN", jarvisToken]]) {
    await gh(setupToken, `/repos/${owner}/${REPO}/actions/secrets/${name}`, {
      method: "PUT", body: JSON.stringify({ encrypted_value: await sealSecret(key.key, value), key_id: key.key_id }),
    });
  }

  step("Avvio la prima lettura…");
  await gh(setupToken, `/repos/${owner}/${REPO}/actions/permissions`, { method: "PUT", body: JSON.stringify({ enabled: true, allowed_actions: "all" }) });
  for (let i = 0; i < 6; i++) {
    const r = await gh(setupToken, `/repos/${owner}/${REPO}/actions/workflows/calendario.yml/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main" }) });
    if (r.status === 204) break;
    await wait(2000); // GitHub può impiegare qualche secondo a registrare la procedura appena caricata
  }
  return { owner, repoUrl: `https://github.com/${owner}/${REPO}` };
}

// ---------- Interfaccia ----------
function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }

export function calendarSetupPanel({ toast, getJarvisToken, onDone }) {
  const box = el(`<div style="display:grid;gap:12px;margin-top:10px">
    <div>
      <strong class="small">1. Il link del tuo calendario</strong>
      <p class="small muted" style="margin:4px 0 6px"><b>Google</b>: calendar.google.com → ⚙️ Impostazioni → il tuo calendario → Integra calendario → <i>Indirizzo segreto in formato iCal</i>.
      <b>Apple</b>: Calendario → Calendari → (i) → Calendario pubblico → Condividi link.</p>
      <input data-url type="url" placeholder="https://calendar.google.com/…/basic.ics" spellcheck="false" autocomplete="off">
    </div>
    <div>
      <strong class="small">2. Un permesso temporaneo di GitHub</strong>
      <p class="small muted" style="margin:4px 0 6px">Apri <a href="${SETUP_TOKEN_URL}" target="_blank" rel="noopener"><b>questa pagina</b></a> (è già compilata), scegli una scadenza breve, per esempio 7 giorni, premi <b>Generate token</b> e incolla qui. Serve solo adesso: Jarvis non lo salva.</p>
      <input data-token type="password" placeholder="ghp_…" spellcheck="false" autocomplete="off">
    </div>
    <button type="button" class="primary wide" data-go>Collega il calendario</button>
    <div data-log class="small muted" style="display:grid;gap:4px"></div>
  </div>`);
  const log = box.querySelector("[data-log]"), go = box.querySelector("[data-go]");
  const line = (text, cls = "") => { const p = document.createElement("div"); p.className = cls; p.textContent = text; log.append(p); };
  go.onclick = async () => {
    log.innerHTML = ""; go.disabled = true;
    try {
      const { repoUrl } = await setupCalendar({
        setupToken: box.querySelector("[data-token]").value,
        calendarUrl: box.querySelector("[data-url]").value,
        jarvisToken: getJarvisToken(),
        step: (t) => line("• " + t),
      });
      box.querySelector("[data-token]").value = "";
      line("Fatto. Tra un paio di minuti i tuoi eventi arrivano in Jarvis.", "");
      const tip = el(`<div class="small muted">Ora puoi cancellare il permesso temporaneo da <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">GitHub → Tokens</a>. La tua procedura è <a href="${repoUrl}" target="_blank" rel="noopener">qui</a>.</div>`);
      log.append(tip);
      toast?.("Calendario collegato: i tuoi eventi arrivano tra poco.");
      onDone?.();
    } catch (err) {
      line(err.message || String(err), "error");
    } finally {
      go.disabled = false;
    }
  };
  return box;
}
