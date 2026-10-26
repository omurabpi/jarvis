// Modifica del Google Calendar. Un browser non può scrivere direttamente nel calendario:
// l'utente pubblica una volta un piccolo Apps Script nel proprio account Google (gira lì, non qui)
// e Jarvis lo chiama con una chiave segreta. Ogni modifica parte solo da un tocco dell'utente.

const CFG = "jarvis.calendarEdit";   // { url, key, name } — si sincronizza tra i dispositivi
const DRAFT = "jarvis.calendarEditKey"; // chiave preparata per il codice da incollare
const DONE = "jarvis.calDone";        // pulsanti già eseguiti: un secondo tocco non duplica
const LIVE = "jarvisCalLive";         // agenda letta dal vivo (sessionStorage: è solo una cache)

const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

export const calEdit = () => read(CFG);
export const calEditOn = () => !!calEdit()?.url;
export function removeCalEdit() { localStorage.removeItem(CFG); sessionStorage.removeItem(LIVE); live = null; }

function draftKey() {
  let k = read(DRAFT);
  if (!k) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    k = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    write(DRAFT, k);
  }
  return k;
}

// ---------- Chiamate allo script ----------
async function call(cfg, op, data = {}) {
  let res;
  try {
    res = await fetch(cfg.url, { method: "POST", body: JSON.stringify({ key: cfg.key, op, ...data }) });
  } catch {
    throw new Error("Il calendario non risponde. Sei online?");
  }
  const out = await res.json().catch(() => null);
  if (!out) throw new Error("Google ha risposto con una pagina invece che con i dati: nel deployment, «Chi ha accesso» deve essere «Chiunque».");
  if (!out.ok) throw new Error(out.error || "Il calendario ha rifiutato la richiesta.");
  return out.result;
}
export const calCall = (op, data) => {
  const cfg = calEdit();
  if (!cfg?.url) return Promise.reject(new Error("Calendario non collegato."));
  return call(cfg, op, data);
};

// ---------- Agenda dal vivo ----------
let live = (() => { try { return JSON.parse(sessionStorage.getItem(LIVE)); } catch { return null; } })();
export const hasLive = () => !!live?.events;

export async function refreshLive() {
  if (!calEditOn()) return;
  const from = new Date(Date.now() - 864e5).toISOString(), to = new Date(Date.now() + 21 * 864e5).toISOString();
  const events = await calCall("list", { from, to });
  live = { name: calEdit().name || "Google Calendar", events, updated: Date.now() };
  try { sessionStorage.setItem(LIVE, JSON.stringify(live)); } catch {}
}

// Codice breve e stabile per ogni evento (cambia solo se l'evento cambia orario): è quello che l'AI usa.
export function eventRef(e) {
  let h = 2166136261;
  for (const c of e.id + "|" + e.start) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return "c" + (h >>> 0).toString(36).slice(-4);
}
export const findEvent = (ref) => live?.events?.find((e) => eventRef(e) === String(ref || "").trim().replace(/^\[|\]$/g, "")) || null;

export function whenText(e) {
  if (e.allDay) {
    const d = new Date(e.start + "T12:00").toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" });
    return `${d} (tutto il giorno)`;
  }
  const s = new Date(e.start), en = new Date(e.end);
  const t = (d) => d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  return `${s.toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" })} ${t(s)}–${t(en)}`;
}

// Al posto del blocco dell'agenda in sola lettura, quando il calendario è modificabile.
export function calendarEditBlock() {
  if (!hasLive()) return "";
  const now = new Date(), today = now.toLocaleDateString("sv-SE");
  const next = live.events.filter((e) => (e.allDay ? e.end > today : new Date(e.end) > now)).slice(0, 40);
  const list = next.length
    ? next.map((e) => `- [${eventRef(e)}] ${whenText(e)} ${e.title}${e.location ? " · " + e.location : ""}${e.recurring ? " (ricorrente: si sposta o cancella solo dal calendario)" : ""}`).join("\n")
    : "(nessun impegno nelle prossime tre settimane)";
  const at = new Date(live.updated).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  return `\n\nAgenda dal Google Calendar "${live.name}" (letta alle ${at}; il codice tra parentesi quadre identifica l'evento):\n${list}\nPuoi creare, spostare e cancellare eventi con i pulsanti EVENTO, SPOSTA e CANCELLA: l'utente li conferma con un tocco. Ricorda con ironia gli appuntamenti imminenti.`;
}

// ---------- Pulsanti già eseguiti ----------
export function isDone(sig) { return (read(DONE) || []).includes(sig); }
export function markDone(sig) { write(DONE, [...(read(DONE) || []), sig].slice(-200)); }

// ---------- Codice da pubblicare su script.google.com ----------
export function scriptCode(key) {
  return `// Jarvis: collegamento al tuo Google Calendar.
// Pubblicalo come App web con "Esegui come: Me" e "Chi ha accesso: Chiunque".
// Funziona solo con la chiave qui sotto, che conosce soltanto il tuo Jarvis: non condividerla.
var KEY = "${key}";

function doGet() {
  return reply({ ok: true, jarvis: "calendario" });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return reply({ ok: false, error: "Richiesta non valida" }); }
  if (req.key !== KEY) return reply({ ok: false, error: "Chiave sbagliata: ricollega il calendario da Jarvis" });
  try { return reply({ ok: true, result: run(req) }); }
  catch (err) { return reply({ ok: false, error: String((err && err.message) || err) }); }
}

function run(req) {
  var cal = CalendarApp.getDefaultCalendar();
  var tz = cal.getTimeZone();
  function day(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function when(s) { return s.length === 10 ? day(s) : new Date(s); }
  function view(ev) {
    var allDay = ev.isAllDayEvent();
    var s = allDay ? ev.getAllDayStartDate() : ev.getStartTime();
    var en = allDay ? ev.getAllDayEndDate() : ev.getEndTime();
    function fmt(d) { return allDay ? Utilities.formatDate(d, tz, "yyyy-MM-dd") : d.toISOString(); }
    return { id: ev.getId(), title: ev.getTitle(), start: fmt(s), end: fmt(en), allDay: allDay, location: ev.getLocation(), recurring: ev.isRecurringEvent() };
  }
  function find() {
    if (req.at) {
      var t = when(req.at).getTime();
      var hits = cal.getEvents(new Date(t - 60000), new Date(t + 60000)).filter(function (x) { return x.getId() === req.id; });
      if (hits.length) return hits[0];
    }
    var ev = cal.getEventById(req.id);
    if (!ev) throw new Error("Evento non trovato: forse è già stato spostato o cancellato");
    return ev;
  }
  var opts = req.location ? { location: req.location } : {};
  switch (req.op) {
    case "ping":
      return { name: cal.getName(), tz: tz };
    case "list":
      return cal.getEvents(new Date(req.from), new Date(req.to)).slice(0, 250).map(view);
    case "create":
      return view(req.allDay
        ? cal.createAllDayEvent(req.title, day(req.start), day(req.end), opts)
        : cal.createEvent(req.title, new Date(req.start), new Date(req.end), opts));
    case "update": {
      var ev = find();
      if (req.title) ev.setTitle(req.title);
      if (req.start) {
        if (req.allDay) ev.setAllDayDates(day(req.start), day(req.end));
        else ev.setTime(new Date(req.start), new Date(req.end));
      }
      return view(ev);
    }
    case "delete": {
      var gone = find();
      var before = view(gone);
      gone.deleteEvent();
      return before;
    }
  }
  throw new Error("Operazione sconosciuta: " + req.op);
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
`;
}

// ---------- Collegamento, nelle impostazioni ----------
// Si aggiunge da solo nel pannello Impostazioni (come le Autorizzazioni): non tocca index.html.
export function initCalendarEdit({ toast } = {}) {
  const anchor = document.querySelector("#approvals-guide") || document.querySelector("#sheet-settings > header");
  if (!anchor || document.querySelector("#caledit-guide")) return;
  const box = document.createElement("details");
  box.className = "guide";
  box.id = "caledit-guide";
  anchor.after(box);
  const render = () => {
    const cfg = calEdit();
    if (cfg?.url) {
      box.innerHTML = `<summary>Modifica del calendario</summary>
        <p class="small muted" style="margin:10px 0">Collegato a <strong>${(cfg.name || "Google Calendar").replace(/[<>&]/g, "")}</strong>. Posso creare, spostare e cancellare eventi, ma solo dopo un tuo tocco. Prometto di non spostarti le riunioni noiose. Spontaneamente.</p>
        <button type="button" class="ghost danger" data-unlink>Scollega</button>`;
      box.querySelector("[data-unlink]").onclick = () => {
        removeCalEdit();
        toast?.("Scollegato. Per spegnerlo del tutto: script.google.com → progetto Jarvis → Esegui il deployment → Gestisci deployment → Archivia.", 8000);
        render();
      };
      return;
    }
    const key = draftKey();
    box.innerHTML = `<summary>Fammi modificare il calendario</summary>
      <p class="small muted" style="margin:10px 0 6px">Oggi leggo la tua agenda ma non posso toccarla. Per creare, spostare e cancellare eventi del tuo Google Calendar mi serve un piccolo programma che gira nel tuo account Google. Si fa una volta, dal computer, in tre minuti.</p>
      <ol class="small" style="margin:0 0 12px;padding-left:20px;display:grid;gap:6px;color:var(--muted)">
        <li>Apri <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">un nuovo progetto Apps Script</a> con il tuo account Google</li>
        <li>Cancella il testo che c'è, poi <button type="button" class="ghost" data-copy style="padding:6px 12px;font-size:.85rem">Copia il codice</button> e incollalo al suo posto</li>
        <li>Salva (icona del dischetto), poi in alto <strong>Esegui il deployment → Nuovo deployment</strong>, tipo <strong>App web</strong></li>
        <li><strong>Esegui come:</strong> Me · <strong>Chi ha accesso:</strong> Chiunque → <strong>Esegui il deployment</strong></li>
        <li>Autorizza l'accesso al calendario. Google dirà che l'app non è verificata: <em>Avanzate → Vai a… (non sicuro)</em>. È il tuo codice, sei tu lo sviluppatore</li>
        <li>Copia l'<strong>URL dell'app web</strong> e incollalo qui:</li>
      </ol>
      <input data-url placeholder="https://script.google.com/macros/s/…/exec" spellcheck="false" autocomplete="off">
      <button type="button" class="primary wide" data-link style="margin-top:10px">Collega</button>
      <p class="small" data-msg hidden style="margin:8px 0 0"></p>`;
    const msg = box.querySelector("[data-msg]");
    box.querySelector("[data-copy]").onclick = async (e) => {
      try { await navigator.clipboard.writeText(scriptCode(key)); e.target.textContent = "Copiato"; }
      catch { toast?.("Non riesco a copiare: apri Jarvis dal computer e riprova.", 5000); }
    };
    box.querySelector("[data-link]").onclick = async () => {
      const url = box.querySelector("[data-url]").value.trim();
      msg.hidden = false;
      if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url)) { msg.className = "small error"; msg.textContent = "Serve l'URL dell'app web: inizia con https://script.google.com/macros/s/ e finisce con /exec."; return; }
      msg.className = "small muted"; msg.textContent = "Busso alla porta del calendario…";
      try {
        const info = await call({ url, key }, "ping");
        write(CFG, { url, key, name: info.name });
        localStorage.removeItem(DRAFT);
        await refreshLive().catch(() => {});
        toast?.(`Collegato a "${info.name}". Ora posso spostarti gli appuntamenti. Con giudizio.`, 5000);
        render();
      } catch (err) {
        msg.className = "small error"; msg.textContent = err.message;
      }
    };
  };
  render();
  // L'agenda dal vivo: subito, poi ogni 10 minuti e quando l'app torna in primo piano dopo un po'.
  const tick = () => { if (calEditOn() && !document.hidden && (!live || Date.now() - live.updated > 5 * 60000)) refreshLive().catch(() => {}); };
  tick();
  setInterval(tick, 10 * 60000);
  document.addEventListener("visibilitychange", tick);
}
