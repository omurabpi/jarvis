// Permesso del microfono. Il codice non può renderlo permanente: decide il browser.
// Qui capisco se il browser lo dimentica a ogni avvio e spiego, per il dispositivo in uso,
// quale impostazione toccare perché smetta di chiederlo.
const GRANTED = "jarvis.micGranted";

// Da chiamare quando il microfono ha funzionato almeno una volta.
export function rememberMic() { try { localStorage.setItem(GRANTED, "1"); } catch {} }

// "granted" | "prompt" | "denied" | "unknown"
export async function micPermission() {
  try { return (await navigator.permissions.query({ name: "microphone" })).state; }
  catch { return "unknown"; }
}

// Vero se il microfono era già stato concesso ma il browser lo richiederà di nuovo.
export async function micForgets() {
  let before = false;
  try { before = localStorage.getItem(GRANTED) === "1"; } catch {}
  return before && (await micPermission()) === "prompt";
}

export function micPlatform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Edg\//.test(ua)) return "edge";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Chrome\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

export const MIC_STEPS = {
  ios: [
    "Apri <strong>Impostazioni</strong> dell'iPhone",
    "Vai su <strong>App → Safari</strong> (sugli iOS meno recenti direttamente <strong>Safari</strong>)",
    "Scorri fino a <em>Impostazioni dei siti web</em> e tocca <strong>Microfono</strong>",
    "Scegli <strong>Consenti</strong>",
    "Nota: così vale per tutti i siti. Se preferisci solo Jarvis, aprilo in Safari e tocca <strong>aA → Impostazioni sito web → Microfono → Consenti</strong>",
  ],
  android: [
    "Quando compare la richiesta scegli <strong>Consenti durante la visita del sito</strong>, non «Solo questa volta»",
    "Se l'hai già data a metà: tocca il simbolo a sinistra dell'indirizzo → <strong>Autorizzazioni → Microfono → Consenti</strong>",
  ],
  chrome: [
    "Clicca il simbolo a sinistra dell'indirizzo (lucchetto o due barrette)",
    "<strong>Impostazioni sito → Microfono → Consenti</strong>",
    "D'ora in poi, alla richiesta, scegli <strong>Consenti durante la visita del sito</strong>, non «Consenti questa volta»",
  ],
  edge: [
    "Clicca il lucchetto a sinistra dell'indirizzo",
    "<strong>Autorizzazioni per questo sito → Microfono → Consenti</strong>",
  ],
  safari: [
    "Menu <strong>Safari → Impostazioni → Siti web</strong>",
    "A sinistra scegli <strong>Microfono</strong>",
    "Accanto a <strong>omurabpi.github.io</strong> imposta <strong>Consenti</strong>",
  ],
  firefox: ["Alla prossima richiesta spunta <strong>Ricorda questa decisione</strong> e scegli <strong>Consenti</strong>"],
  other: ["Nelle impostazioni del browser, tra i permessi del sito, imposta il <strong>Microfono</strong> su <strong>Consenti</strong>"],
};
