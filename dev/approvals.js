// Pannello "Autorizzazioni": tutto ciò a cui Jarvis ha accesso, da quando, e come revocarlo.
// Si aggiunge da solo nelle impostazioni (non tocca index.html).

import { readCalendar, calendarEnabled } from "./calendar.js";
import { MIC_STEPS, micPlatform, micForgets } from "./mic.js";

const get = (k, d = null) => { try { return JSON.parse(localStorage.getItem("jarvis." + k)) ?? d; } catch { return d; } };
const set = (k, v) => localStorage.setItem("jarvis." + k, JSON.stringify(v));
const NAMES = { gemini: "Gemini", claude: "Claude", openai: "ChatGPT", mistral: "Mistral", groq: "Groq", deepseek: "DeepSeek", xai: "Grok", openrouter: "OpenRouter" };

function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
const day = (ts) => new Date(ts).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Data della prima volta che un'autorizzazione è stata vista attiva (registro locale, sincronizzato).
function since(id, active) {
  const log = get("approvals", {});
  if (active && !log[id]) { log[id] = Date.now(); set("approvals", log); }
  if (!active && log[id]) { delete log[id]; set("approvals", log); }
  return log[id];
}

async function micState() {
  try { return (await navigator.permissions.query({ name: "microphone" })).state; } catch { return "unknown"; }
}

function updateSettings(patch, toast, msg) {
  set("settings", { ...get("settings", {}), ...patch });
  toast?.(msg);
  setTimeout(() => location.reload(), 900);
}

// I passaggi per rendere permanente il permesso, su questo dispositivo, aperti sotto la voce.
function toggleMicSteps(btn) {
  const box = btn.parentElement, open = box.querySelector(".mic-steps");
  if (open) { open.remove(); return; }
  box.append(el(`<ol class="mic-steps small muted" style="margin:8px 0 0;padding-left:18px;display:grid;gap:4px">${MIC_STEPS[micPlatform()].map((s) => `<li>${s}</li>`).join("")}</ol>`));
}

async function items(toast) {
  const settings = get("settings", {}), github = get("github"), cal = readCalendar(), mic = await micState();
  const contacts = get("contacts", []);
  const list = [];

  const forgets = await micForgets();
  list.push({
    id: "microphone", title: "Microfono", active: mic === "granted",
    detail: mic === "granted" ? "Jarvis ascolta solo quando tocchi il reattore o pronunci la parola d'attivazione."
      : mic === "denied" ? "Bloccato: Jarvis non può sentirti."
      : forgets ? "Il browser lo dimentica e te lo richiede a ogni avvio. Memoria da pesce rosso: si cura in un minuto."
      : "Te lo chiederà alla prima conversazione a voce.",
    action: mic === "unknown" ? null
      : { label: mic === "granted" ? "Come cambiarlo" : mic === "denied" ? "Come sbloccarlo" : "Non chiedermelo più", run: (e) => toggleMicSteps(e.currentTarget) },
  });

  list.push({
    id: "github", title: "Account GitHub", active: !!github,
    detail: github ? `@${esc(github.login)}: chat, memoria e impostazioni salvate cifrate nel tuo gist segreto.` : "Non collegato: i dati restano solo su questo dispositivo.",
    action: github ? { label: "Revoca", danger: true, run: () => { localStorage.removeItem("jarvis.github"); toast?.("Account scollegato: i dati restano qui."); setTimeout(() => location.reload(), 900); } } : null,
  });

  const calOn = !!cal && calendarEnabled();
  list.push({
    id: "calendar", title: "Calendario", active: calOn,
    detail: calOn ? `"${esc(cal.name || "Calendario")}": ${cal.events?.length || 0} eventi nelle prossime tre settimane, aggiornati ogni 30 minuti dalla tua procedura su GitHub.`
      : cal ? "Disattivato: Jarvis non usa più i tuoi eventi."
      : "Non collegato. Google Calendar o Apple: si collega una volta dal tuo GitHub, circa 5 minuti.",
    action: calOn ? { label: "Revoca", danger: true, run: () => {
      localStorage.setItem("jarvis.calendarOff", "true"); localStorage.removeItem("jarvis.calendar");
      toast?.("Calendario scollegato. Per fermare anche la lettura elimina la tua copia jarvis-calendario su GitHub.", 7000);
      setTimeout(() => location.reload(), 1500);
    } } : cal || localStorage.getItem("jarvis.calendarOff") ? { label: "Riattiva", run: () => { localStorage.removeItem("jarvis.calendarOff"); toast?.("Calendario riattivato: arriva alla prossima sincronizzazione."); setTimeout(() => location.reload(), 900); } }
      : { label: "Collegalo", run: () => window.open("https://github.com/omurabpi/jarvis-calendario-modello#readme", "_blank", "noopener") },
  });

  const elevenOn = settings.engine !== "gemini" && settings.engine !== "browser";
  list.push({
    id: "elevenlabs", title: "Voce ElevenLabs", active: elevenOn,
    detail: elevenOn ? "Durante le conversazioni a voce l'audio passa da ElevenLabs (trascrizione e voce) e il testo da Claude." : "Disattivata: a voce usa Gemini Live o la voce del telefono.",
    action: elevenOn ? { label: "Revoca", danger: true, run: () => updateSettings({ engine: "gemini" }, toast, "Voce ElevenLabs disattivata.") }
      : { label: "Riattiva", run: () => updateSettings({ engine: undefined }, toast, "Voce ElevenLabs riattivata.") },
  });

  const learnOn = settings.learn !== false;
  list.push({
    id: "learning", title: "Memoria automatica", active: learnOn,
    detail: learnOn ? "Dopo ogni conversazione Jarvis annota quello che impara su di te (lo vedi in Memoria)." : "Disattivata: Jarvis non impara più dalle conversazioni.",
    action: learnOn ? { label: "Revoca", danger: true, run: () => updateSettings({ learn: false }, toast, "Memoria automatica disattivata.") }
      : { label: "Riattiva", run: () => updateSettings({ learn: true }, toast, "Memoria automatica riattivata.") },
  });

  if (contacts.length || since("contacts", false)) list.push({
    id: "contacts", title: "Rubrica", active: contacts.length > 0,
    detail: contacts.length ? `${contacts.length} contatti salvati in Jarvis per scrivere e chiamare.` : "Nessun contatto.",
    action: contacts.length ? { label: "Revoca", danger: true, run: () => { set("contacts", []); toast?.("Rubrica di Jarvis svuotata."); setTimeout(() => location.reload(), 900); } } : null,
  });

  for (const [provider, key] of Object.entries(settings.keys || {})) {
    if (!key) continue;
    const name = NAMES[provider] || provider;
    list.push({
      id: "key-" + provider, title: `Chiave ${name}`, active: true,
      detail: `Usata per ${provider === settings.provider ? "la chat scritta, le ricerche e la memoria" : "nulla al momento (non è l'AI attiva)"}. Finisce in …${esc(key.slice(-4))}.`,
      action: { label: "Revoca", danger: true, run: () => {
        if (provider === settings.provider) { toast?.(`È la chiave dell'AI attiva: scegli prima un'altra AI nelle impostazioni.`, 5000); return; }
        const keys = { ...settings.keys }; delete keys[provider];
        updateSettings({ keys }, toast, `Chiave ${name} rimossa da Jarvis.`);
      } },
    });
  }
  return list;
}

async function render(box, toast) {
  const list = await items(toast);
  box.innerHTML = "";
  for (const it of list) {
    const ts = since(it.id, it.active);
    const row = el(`<div style="display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid var(--line)">
      <span style="width:9px;height:9px;border-radius:50%;margin-top:7px;flex:none;background:${it.active ? "#4ade80" : "var(--line-strong)"}"></span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
          <strong style="font-size:.95rem">${it.title}</strong>
          <span class="small muted" style="white-space:nowrap">${it.active ? (ts ? "dal " + day(ts) : "attiva") : "non attiva"}</span>
        </div>
        <div class="small muted" style="margin-top:2px">${it.detail}</div>
      </div>
    </div>`);
    if (it.action) {
      const b = el(`<button type="button" style="background:none;border:0;padding:0;margin-top:6px;font-size:.82rem;cursor:pointer;color:${it.action.danger ? "var(--danger)" : "var(--accent)"}">${it.action.label}</button>`);
      b.onclick = it.action.run;
      row.querySelector("div").append(b);
    }
    box.append(row);
  }
}

export function initApprovals({ toast } = {}) {
  const anchor = document.querySelector("#sync-guide") || document.querySelector("#sheet-settings > header");
  if (!anchor || document.querySelector("#approvals-guide")) return;
  const details = el(`<details class="guide" id="approvals-guide"><summary>Autorizzazioni</summary>
    <p class="small muted" style="margin:8px 0 4px">Tutto ciò a cui Jarvis ha accesso, da quando, e come revocarlo.</p><div data-list></div></details>`);
  anchor.after(details);
  const box = details.querySelector("[data-list]");
  details.addEventListener("toggle", () => details.open && render(box, toast));
  document.querySelector('[data-open="settings"]')?.addEventListener("click", () => details.open && render(box, toast));
}
