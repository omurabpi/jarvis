// Conversazione vocale in tempo reale con Gemini Live (WebSocket diretto dal browser).
// Microfono -> PCM 16 kHz -> Gemini; Gemini -> PCM 24 kHz -> altoparlante.
// Si può interrompere Jarvis parlando sopra: il server segnala "interrupted".

const LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const VOICES = [
  { id: "Charon", label: "Charon — profonda e pacata" },
  { id: "Orus", label: "Orus — decisa" },
  { id: "Fenrir", label: "Fenrir — energica" },
  { id: "Puck", label: "Puck — vivace" },
  { id: "Kore", label: "Kore — femminile, chiara" },
  { id: "Aoede", label: "Aoede — femminile, morbida" },
];

// Modelli Gemini che supportano la conversazione in tempo reale per questa chiave.
export async function pickLiveModel(key) {
  const res = await fetch(GEMINI_BASE + "/models?pageSize=1000", { headers: { "x-goog-api-key": key } });
  if (!res.ok) return null;
  const { models = [] } = await res.json();
  const live = models
    .filter((m) => (m.supportedGenerationMethods || []).includes("bidiGenerateContent"))
    .map((m) => m.name.replace(/^models\//, ""));
  const ver = (id) => parseFloat((id.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const sorted = live.sort((a, b) => ver(b) - ver(a));
  return sorted.find((id) => /native-audio/.test(id)) || sorted.find((id) => /live/.test(id)) || sorted[0] || null;
}

// Cattura del microfono: media a blocchi, ricampiona a 16 kHz, misura il volume.
const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.ratio = sampleRate / 16000; this.acc = 0; this.pos = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    for (let i = 0; i < ch.length; i++) {
      this.pos += 1;
      if (this.pos >= this.ratio) { this.pos -= this.ratio; this.buf.push(ch[i]); }
    }
    if (this.buf.length >= 1600) { // 100 ms
      const pcm = new Int16Array(this.buf.length);
      for (let i = 0; i < this.buf.length; i++) pcm[i] = Math.max(-1, Math.min(1, this.buf[i])) * 0x7fff;
      this.port.postMessage({ pcm: pcm.buffer, level: Math.sqrt(sum / ch.length) }, [pcm.buffer]);
      this.buf = [];
    }
    return true;
  }
}
registerProcessor("jarvis-capture", Capture);
`;

const toBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

export class LiveSession {
  /**
   * handlers: onState(state), onLevel(0..1), onUserText(text, final), onJarvisText(text, final),
   *           onToolCall({name, args}) -> result, onError(message), onClose()
   */
  constructor({ key, model, voice, system, tools, handlers }) {
    Object.assign(this, { key, model, voice, system, tools, h: handlers });
    this.sources = new Set();
    this.nextTime = 0;
    this.userText = "";
    this.jarvisText = "";
    this.closed = false;
  }

  // Va chiamato dentro un tocco dell'utente (iPhone sblocca l'audio solo così).
  async start() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();
    this.out = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.out.connect(this.analyser).connect(this.ctx.destination);
    this.meter();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "application/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.mic = this.ctx.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(this.ctx, "jarvis-capture");
    this.capture.port.onmessage = (e) => {
      this.micLevel = e.data.level;
      if (this.ready && !this.muted) this.send({ realtimeInput: { audio: { data: toBase64(e.data.pcm), mimeType: "audio/pcm;rate=16000" } } });
    };
    this.mic.connect(this.capture);

    await this.connect();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${LIVE_URL}?key=${encodeURIComponent(this.key)}`);
      this.ws.onopen = () => {
        this.send({
          setup: {
            model: "models/" + this.model,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
            },
            systemInstruction: { parts: [{ text: this.system }] },
            tools: this.tools,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            contextWindowCompression: { slidingWindow: {} },
          },
        });
      };
      this.ws.onmessage = async (e) => {
        const raw = typeof e.data === "string" ? e.data : await e.data.text();
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.setupComplete) { this.ready = true; this.h.onState("listening"); resolve(); return; }
        this.handle(msg);
      };
      this.ws.onerror = () => reject(new Error("Connessione vocale non riuscita."));
      this.ws.onclose = (e) => {
        this.ready = false;
        if (!this.closed) {
          const reason = e.reason || "";
          if (/api key|API_KEY/i.test(reason)) this.h.onError("La chiave Gemini non è valida.");
          else if (/quota|exhausted|429/i.test(reason)) this.h.onError("Limite gratuito della voce raggiunto. Riprova più tardi o scrivi.");
          else if (reason) this.h.onError("Conversazione chiusa: " + reason);
          reject(new Error(reason || "Connessione chiusa."));
        }
        this.stop();
      };
    });
  }

  send(obj) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  // Testo scritto durante la conversazione (o istruzione iniziale).
  sendText(text) {
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } });
  }

  async handle(msg) {
    const sc = msg.serverContent;
    if (sc) {
      if (sc.interrupted) this.flush();
      for (const part of sc.modelTurn?.parts || []) {
        if (part.inlineData?.data) this.play(part.inlineData.data, part.inlineData.mimeType);
      }
      if (sc.inputTranscription?.text) {
        this.userText += sc.inputTranscription.text;
        this.h.onUserText(this.userText, false);
      }
      if (sc.outputTranscription?.text) {
        if (this.userText) { this.h.onUserText(this.userText, true); this.userText = ""; }
        this.jarvisText += sc.outputTranscription.text;
        this.h.onJarvisText(this.jarvisText, false);
      }
      if (sc.turnComplete) {
        if (this.userText) { this.h.onUserText(this.userText, true); this.userText = ""; }
        if (this.jarvisText) { this.h.onJarvisText(this.jarvisText, true); this.jarvisText = ""; }
        const wait = Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000);
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.ready && this.h.onState("listening"), wait);
      }
    }
    if (msg.toolCall) {
      this.h.onState("thinking");
      const functionResponses = [];
      for (const call of msg.toolCall.functionCalls || []) {
        let result;
        try { result = await this.h.onToolCall({ name: call.name, args: call.args || {} }); }
        catch (err) { result = { errore: String(err.message || err) }; }
        functionResponses.push({ id: call.id, name: call.name, response: { result: result ?? "ok" } });
      }
      this.send({ toolResponse: { functionResponses } });
    }
    if (msg.goAway) this.h.onError("La conversazione sta per scadere: tocca il reattore per riprendere.");
  }

  play(b64, mime = "") {
    const rate = parseInt((mime.match(/rate=(\d+)/) || [0, 24000])[1]);
    const pcm = new Int16Array(fromBase64(b64));
    const buf = this.ctx.createBuffer(1, pcm.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    this.nextTime = Math.max(this.nextTime, this.ctx.currentTime + 0.05);
    src.start(this.nextTime);
    this.nextTime += buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    clearTimeout(this.idleTimer);
    this.h.onState("speaking");
  }

  // Interruzione: zittisce subito la voce in coda.
  flush() {
    for (const s of this.sources) { try { s.stop(); } catch {} }
    this.sources.clear();
    this.nextTime = 0;
    if (this.jarvisText) { this.h.onJarvisText(this.jarvisText + "…", true); this.jarvisText = ""; }
    this.h.onState("listening");
  }

  // Volume combinato (voce di Jarvis + microfono) per animare il reattore.
  meter() {
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    const tick = () => {
      if (!this.ctx || this.ctx.state === "closed") return;
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) { const x = (v - 128) / 128; sum += x * x; }
      const out = Math.sqrt(sum / data.length);
      const level = Math.min(1, Math.max(out * 4, (this.micLevel || 0) * 6));
      this.h.onLevel(level);
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    cancelAnimationFrame(this.raf);
    try { this.ws?.close(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    try { this.ctx?.close(); } catch {}
    this.h.onLevel(0);
    this.h.onClose?.();
  }
}
