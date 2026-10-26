// Azioni verso le altre app del telefono. Jarvis le propone con righe
// [[AZIONE: TIPO | campo | campo ...]]; l'app le trasforma in pulsanti che aprono
// l'app giusta con i dati già compilati. L'invio resta sempre all'utente.

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const enc = encodeURIComponent;
const phone = (s = "") => s.replace(/[^\d+]/g, "");
// Formato internazionale (serve a wa.me); senza prefisso si assume un numero italiano.
const intl = (n) => !n || n.startsWith("+") ? n : n.startsWith("00") ? "+" + n.slice(2) : n.startsWith("39") && n.length >= 11 ? "+" + n : "+39" + n;
export const normalizePhone = (s) => intl(phone(String(s || "")));

// Rubrica: l'app registra qui come trovare un contatto dal nome ("Marco" → numero).
let phoneBook = () => null;
export function usePhoneBook(find) { phoneBook = find; }

// Il campo numero può contenere un numero oppure il nome di un contatto in rubrica.
function resolve(s = "") {
  const num = phone(s);
  if (num.replace("+", "").length >= 6) return { num, name: "" };
  const c = s.trim() ? phoneBook(s.trim()) : null;
  return c ? { num: c.phone, name: c.name } : { num: "", name: "" };
}

export const ACTIONS_PROMPT = `Azioni sul telefono — quando è utile, proponi a fine risposta uno o più pulsanti con righe esattamente in questi formati (i campi tra parentesi quadre sono facoltativi, lasciali vuoti se non li conosci):
[[AZIONE: EVENTO | titolo | AAAA-MM-GG HH:MM | durata in minuti | [luogo]]]
[[AZIONE: WHATSAPP | testo del messaggio | [numero con prefisso, oppure nome in rubrica]]]
[[AZIONE: EMAIL | [destinatario] | oggetto | testo]]
[[AZIONE: CHIAMA | numero oppure nome in rubrica]]
[[AZIONE: SMS | [numero oppure nome in rubrica] | testo]]
[[AZIONE: MAPPA | luogo o indirizzo]]
Usale per appuntamenti, messaggi e email che hai scritto, numeri e luoghi citati. Se il destinatario è in rubrica scrivi il suo nome al posto del numero: l'app lo trova da sola. Non inventare numeri o indirizzi email: se non li conosci lascia il campo vuoto.`;

// Estrae le azioni dal testo. Restituisce il testo pulito e l'elenco delle azioni valide.
export function parseActions(text) {
  const actions = [];
  const clean = text.replace(/\[\[AZIONE:\s*([A-Z]+)\s*\|?([\s\S]*?)\]\]/g, (_, type, rest) => {
    const f = rest.split("|").map((s) => s.trim());
    const a = build(type, f);
    if (a) actions.push(a);
    return "";
  });
  return { clean, actions };
}

// Stessa azione richiesta con argomenti con nome (strumenti della conversazione vocale).
const FIELDS = {
  EVENTO: ["titolo", "quando", "durata", "luogo"],
  WHATSAPP: ["testo", "numero"],
  EMAIL: ["destinatario", "oggetto", "testo"],
  CHIAMA: ["numero"],
  SMS: ["numero", "testo"],
  MAPPA: ["luogo"],
};
export function buildAction(tipo, args = {}) {
  const type = String(tipo || "").toUpperCase();
  return FIELDS[type] ? build(type, FIELDS[type].map((k) => String(args[k] ?? "").trim())) : null;
}

function build(type, f) {
  switch (type) {
    case "EVENTO": {
      const [title, when, minutes, place] = f;
      const m = (when || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
      if (!title || !m) return null;
      return { kind: "event", label: "Aggiungi al calendario", title, date: m.slice(1, 4).join("-"), time: m[4] ? `${m[4]}:${m[5]}` : null, minutes: parseInt(minutes) || 60, place: place || "" };
    }
    case "WHATSAPP": {
      const [body, to] = f;
      if (!body) return null;
      const c = resolve(to);
      return { kind: "link", label: "Invia su WhatsApp" + (c.name ? " a " + c.name : ""), href: `https://wa.me/${intl(c.num).replace(/^\+/, "")}?text=${enc(body)}` };
    }
    case "EMAIL": {
      const [to, subject, body] = f;
      if (!subject && !body) return null;
      return { kind: "link", label: "Scrivi email", href: `mailto:${to || ""}?subject=${enc(subject || "")}&body=${enc(body || "")}` };
    }
    case "CHIAMA": {
      const c = resolve(f[0]);
      return c.num ? { kind: "link", label: "Chiama " + (c.name || c.num), href: "tel:" + c.num } : null;
    }
    case "SMS": {
      const [to, body] = f;
      if (!body) return null;
      const c = resolve(to);
      return { kind: "link", label: "Invia SMS" + (c.name ? " a " + c.name : ""), href: `sms:${c.num}${isIOS ? "&" : "?"}body=${enc(body)}` };
    }
    case "MAPPA": {
      const q = f[0];
      if (!q) return null;
      return { kind: "link", label: "Apri in Mappe", href: isIOS ? `https://maps.apple.com/?q=${enc(q)}` : `https://www.google.com/maps/search/?api=1&query=${enc(q)}` };
    }
    default:
      return null;
  }
}

// ---------- Calendario ----------
const pad = (n) => String(n).padStart(2, "0");
const stamp = (d, allDay) => allDay
  ? `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  : `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const icsText = (s) => s.replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");

function eventTimes(a) {
  const start = new Date(`${a.date}T${a.time || "00:00"}:00`);
  const end = a.time ? new Date(start.getTime() + a.minutes * 60000) : new Date(start.getTime() + 86400000);
  return { start, end, allDay: !a.time };
}

// iPhone: file .ics (si apre "Aggiungi al calendario"). Android: Google Calendar.
function eventHref(a) {
  const { start, end, allDay } = eventTimes(a);
  if (isIOS) {
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Jarvis//IT", "BEGIN:VEVENT",
      `UID:${Date.now()}@jarvis`, `DTSTAMP:${stamp(new Date())}`,
      allDay ? `DTSTART;VALUE=DATE:${stamp(start, true)}` : `DTSTART:${stamp(start)}`,
      allDay ? `DTEND;VALUE=DATE:${stamp(end, true)}` : `DTEND:${stamp(end)}`,
      `SUMMARY:${icsText(a.title)}`, a.place ? `LOCATION:${icsText(a.place)}` : "",
      "END:VEVENT", "END:VCALENDAR",
    ].filter(Boolean).join("\r\n");
    return { href: "data:text/calendar;charset=utf-8," + enc(ics), download: "evento.ics" };
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dates = `${stamp(start, allDay)}/${stamp(end, allDay)}`;
  return { href: `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(a.title)}&dates=${dates}&ctz=${enc(tz)}&location=${enc(a.place)}` };
}

// Crea i pulsanti per un messaggio.
export function actionButtons(actions) {
  return actions.map((a) => {
    const link = document.createElement("a");
    link.className = "action";
    link.target = "_blank";
    link.rel = "noopener";
    if (a.kind === "event") {
      const { href, download } = eventHref(a);
      link.href = href;
      if (download) link.download = download;
      const when = new Date(`${a.date}T${a.time || "12:00"}:00`).toLocaleString("it-IT", { weekday: "short", day: "numeric", month: "short", ...(a.time ? { hour: "2-digit", minute: "2-digit" } : {}) });
      link.textContent = `${a.label} · ${when}`;
    } else {
      link.href = a.href;
      link.textContent = a.label;
    }
    return link;
  });
}

// Condivisione di sistema (WhatsApp, Mail, Note...). Ritorna false se non disponibile.
export async function shareText(text) {
  if (!navigator.share) return false;
  try { await navigator.share({ text }); } catch { /* annullato dall'utente */ }
  return true;
}
