// Conversazione vocale con l'agente ElevenLabs di Jarvis (voce premium).
// L'agente è pubblico ma accetta connessioni solo dal sito di Jarvis.
// Stessa interfaccia di LiveSession (voice.js): start(), sendText(), stop().

const SDK_URL = "https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.31.0/+esm";

// ID dell'agente creato via API sull'account ElevenLabs di Francesco.
export const ELEVEN_AGENT_ID = "agent_4601m5w93gzwe9t90bj4fjy94jk7";

export const elevenAvailable = () => !!ELEVEN_AGENT_ID;

export class ElevenSession {
  /** handlers: come LiveSession (onState, onLevel, onUserText, onJarvisText, onToolCall, onError, onClose) */
  constructor({ variables, tools, handlers }) {
    Object.assign(this, { variables, tools, h: handlers });
    this.closed = false;
  }

  async start() {
    const { VoiceConversation } = await import(SDK_URL);
    const clientTools = {};
    for (const name of this.tools) {
      clientTools[name] = async (params) => {
        const result = await this.h.onToolCall({ name, args: params || {} });
        return typeof result === "string" ? result : JSON.stringify(result ?? "ok");
      };
    }
    this.conv = await VoiceConversation.startSession({
      agentId: ELEVEN_AGENT_ID,
      connectionType: "webrtc",
      dynamicVariables: this.variables,
      clientTools,
      onConnect: () => this.h.onState("listening"),
      onModeChange: ({ mode }) => this.h.onState(mode === "speaking" ? "speaking" : "listening"),
      onMessage: ({ message, role, source }) => {
        const who = role || (source === "ai" ? "agent" : "user");
        if (who === "user") this.h.onUserText(message, true);
        else this.h.onJarvisText(message, true);
      },
      onError: (message) => this.h.onError(typeof message === "string" ? message : "Errore della voce ElevenLabs."),
      onDisconnect: () => this.stop(),
    });
    this.meter();
  }

  sendText(text) { this.conv?.sendUserMessage(text); }

  meter() {
    const tick = () => {
      if (this.closed || !this.conv) return;
      const level = Math.min(1, Math.max(this.conv.getOutputVolume() * 1.6, this.conv.getInputVolume() * 1.2));
      this.h.onLevel(level);
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    cancelAnimationFrame(this.raf);
    this.conv?.endSession().catch(() => {});
    this.h.onLevel(0);
    this.h.onClose?.();
  }
}
