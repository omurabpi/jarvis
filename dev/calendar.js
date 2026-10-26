// Agenda dal calendario Apple: GitHub Actions la scrive cifrata nel gist (tools/calendario),
// sync.js la decifra in localStorage "jarvis.calendar" e da qui entra nel contesto di Jarvis.

export function readCalendar() {
  try { return JSON.parse(localStorage.getItem("jarvis.calendar")) || null; } catch { return null; }
}
export const calendarEnabled = () => localStorage.getItem("jarvis.calendarOff") !== "true";

function when(e) {
  const day = new Date(e.a ? e.s + "T12:00" : e.s).toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" });
  return e.a ? `${day} (tutto il giorno)` : `${day} ${e.s.slice(11, 16)}–${e.e.slice(11, 16)}`;
}

// Blocco da aggiungere al contesto dei prompt (vuoto se il calendario non è collegato o è disattivato).
export function calendarBlock() {
  const cal = readCalendar();
  if (!calendarEnabled() || !cal?.events) return "";
  const now = new Date(), today = now.toLocaleDateString("sv-SE");
  const next = cal.events.filter((e) => (e.a ? e.e > today : new Date(e.e) > now)).slice(0, 40);
  const list = next.length ? next.map((e) => `- ${when(e)} ${e.t}${e.l ? " · " + e.l : ""}`).join("\n") : "(nessun impegno nelle prossime tre settimane)";
  return `\n\nAgenda dal calendario Apple "${cal.name || "Calendario"}" (aggiornata ${cal.updated ? new Date(cal.updated).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "di recente"}):\n${list}\nUsala per rispondere sugli impegni e per ricordare con ironia gli appuntamenti imminenti. Non puoi modificare il calendario: per un nuovo evento proponi il pulsante EVENTO.`;
}
