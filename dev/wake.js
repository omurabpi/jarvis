// Parola d'attivazione: finché Jarvis è aperto, il riconoscimento vocale del browser
// (Apple o Google, nessun modello in locale) ascolta e, quando sente "Jarvis", lo sveglia.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const wakeAvailable = () => !!SR;

// Come il riconoscimento italiano tende a scrivere "Jarvis": giarvis, jervis, jarbis, ciarvis…
const WAKE = /\b(?:j|g|gi|ci|ch|dj)[ae]r[vb]i(?:s|ss|z)?\b/i;

export class WakeWord {
  constructor(onWake) {
    this.onWake = onWake;
    this.onDenied = null;
    this.on = false;
    this.rec = null;
    this.pause = 300;
    // Il browser sospende il microfono quando l'app va in secondo piano: al ritorno si riparte.
    document.addEventListener("visibilitychange", () => { if (!document.hidden && this.on && !this.rec) this.listen(); });
  }

  start() {
    if (!SR || this.on) return;
    this.on = true;
    this.listen();
  }

  stop() {
    this.on = false;
    clearTimeout(this.timer);
    const rec = this.rec;
    this.rec = null;
    try { rec?.abort(); } catch {}
  }

  listen() {
    if (!this.on || this.rec) return;
    const rec = (this.rec = new SR());
    rec.lang = "it-IT";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    const startedAt = Date.now();
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        for (let j = 0; j < e.results[i].length; j++) {
          if (WAKE.test(e.results[i][j].transcript)) { this.fire(); return; }
        }
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") { this.stop(); this.onDenied?.(); }
    };
    // Il riconoscimento si chiude da solo dopo un po' di silenzio: si riapre, rallentando se si chiude subito.
    rec.onend = () => {
      if (this.rec !== rec) return;
      this.rec = null;
      if (!this.on) return;
      this.pause = Date.now() - startedAt < 1500 ? Math.min(this.pause * 2, 10000) : 300;
      this.timer = setTimeout(() => this.listen(), this.pause);
    };
    try { rec.start(); } catch { this.rec = null; this.timer = setTimeout(() => this.listen(), 1000); }
  }

  fire() {
    this.stop();
    this.onWake();
  }
}
