// Provider AI. Ognuno espone: listModels(key) -> [{id, label}], pickDefault(models),
// chat({key, model, system, history, onText}) -> {text, sources}.
// Tutte le chiamate partono dal browser con la chiave dell'utente.

const ANTHROPIC_SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export class ProviderError extends Error {}

const REFUSAL = "Mi spiace, su questa richiesta non posso aiutarti.";

// Ordina per numero di versione nell'id (es. gpt-5.2 > gpt-5), poi alfabetico.
const version = (id) => parseFloat((id.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]);
const byVersionDesc = (a, b) => version(b.id) - version(a.id) || a.id.localeCompare(b.id);
const firstMatch = (models, ...patterns) => {
  for (const p of patterns) {
    const hit = [...models].sort(byVersionDesc).find((m) => p.test(m.id));
    if (hit) return hit.id;
  }
  return models[0]?.id;
};

// ---------- Claude (SDK ufficiale Anthropic) ----------
let anthropicModule = null;
async function anthropic(key) {
  anthropicModule ??= await import(ANTHROPIC_SDK_URL);
  return new anthropicModule.default({ apiKey: key, dangerouslyAllowBrowser: true });
}

function claudeError(err) {
  const A = anthropicModule?.default;
  if (!A) return err;
  if (err instanceof A.AuthenticationError) return new ProviderError("La chiave Claude non è valida. Controllala nelle Impostazioni.");
  if (err instanceof A.PermissionDeniedError) return new ProviderError("La chiave Claude non ha accesso a questo modello.");
  if (err instanceof A.RateLimitError) return new ProviderError("Troppe richieste o credito esaurito. Riprova tra poco o controlla il credito su console.anthropic.com.");
  if (err instanceof A.BadRequestError && /credit|balance/i.test(err.message)) return new ProviderError("Credito Claude esaurito: ricaricalo su console.anthropic.com (Billing).");
  if (err instanceof A.APIConnectionError) return new ProviderError("Connessione assente o instabile. Riprova.");
  if (err instanceof A.APIError) return new ProviderError("Errore di Claude: " + err.message);
  return err;
}

const claude = {
  async listModels(key) {
    const client = await anthropic(key);
    try {
      const page = await client.models.list({ limit: 100 });
      return page.data.map((m) => ({ id: m.id, label: m.display_name || m.id }));
    } catch (err) { throw claudeError(err); }
  },
  pickDefault: (models) => firstMatch(models, /^claude-opus-5-5$/, /^claude-opus/, /^claude-sonnet/),
  async chat({ key, model, system, history, onText }) {
    const client = await anthropic(key);
    const isHaiku = model.startsWith("claude-haiku");
    const supportsFallback = /^claude-(opus-5|sonnet-5-5|fable)/.test(model);
    const request = {
      model,
      max_tokens: 16000,
      system,
      output_config: { effort: "medium" },
      tools: [{ type: isHaiku ? "web_search_20250305" : "web_search_20260209", name: "web_search", max_uses: 5 }],
    };
    if (supportsFallback) {
      // Se un filtro di sicurezza rifiuta, il server riprova da solo con un modello di riserva.
      request.betas = ["server-side-fallback-2026-07-01"];
      request.fallbacks = "default";
    }
    let messages = history.map((m) => ({ role: m.role, content: m.text }));
    let text = "";
    const sources = new Map();
    try {
      // pause_turn: la ricerca web chiede di continuare lo stesso turno.
      for (let round = 0; round < 4; round++) {
        const stream = client.beta.messages.stream({ ...request, messages });
        stream.on("text", (delta) => { text += delta; onText(text); });
        const msg = await stream.finalMessage();
        for (const block of msg.content) {
          if (block.type === "text" && block.citations) for (const c of block.citations) if (c.url) sources.set(c.url, c.title || c.url);
        }
        if (msg.stop_reason === "refusal") { text += (text ? "\n\n" : "") + REFUSAL; break; }
        if (msg.stop_reason !== "pause_turn") break;
        messages = [...messages, { role: "assistant", content: msg.content }];
      }
    } catch (err) { throw claudeError(err); }
    return { text, sources: [...sources].map(([url, title]) => ({ url, title })) };
  },
};

// ---------- Gemini (REST) ----------
async function geminiError(res) {
  let detail = "";
  try { detail = (await res.json()).error?.message || ""; } catch {}
  if (res.status === 400 && /api key/i.test(detail)) return new ProviderError("La chiave Gemini non è valida. Controllala nelle Impostazioni.");
  if (res.status === 403) return new ProviderError("La chiave Gemini non è autorizzata. Ricreala su aistudio.google.com/apikey.");
  if (res.status === 429) return new ProviderError("Limite gratuito di Gemini raggiunto per ora. Riprova tra qualche minuto.");
  return new ProviderError(`Errore di Gemini (${res.status}): ${detail || res.statusText}`);
}

const gemini = {
  async listModels(key) {
    const res = await fetch(GEMINI_BASE + "/models?pageSize=1000", { headers: { "x-goog-api-key": key } });
    if (!res.ok) throw await geminiError(res);
    const { models = [] } = await res.json();
    return models
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .filter((m) => /^models\/gemini-/.test(m.name) && !/(image|tts|live|embedding|audio|robotics|computer)/.test(m.name))
      .map((m) => ({ id: m.name.replace(/^models\//, ""), label: m.displayName || m.name }));
  },
  pickDefault: (models) => firstMatch(models, /^gemini-\d+(\.\d+)?-flash$/, /^gemini-flash-latest$/, /flash/),
  async chat({ key, model, system, history, onText }) {
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] })),
      tools: [{ google_search: {} }],
    };
    const res = await fetch(`${GEMINI_BASE}/models/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await geminiError(res);
    let text = "";
    const sources = new Map();
    await readSSE(res, (chunk) => {
      const cand = chunk.candidates?.[0];
      for (const part of cand?.content?.parts || []) if (part.text && !part.thought) text += part.text;
      for (const g of cand?.groundingMetadata?.groundingChunks || []) if (g.web?.uri) sources.set(g.web.uri, g.web.title || g.web.uri);
      if (cand?.finishReason === "SAFETY") text += "\n\n" + REFUSAL;
      onText(text);
    });
    return { text, sources: [...sources].map(([url, title]) => ({ url, title })) };
  },
};

// ---------- Provider compatibili OpenAI (chat/completions) ----------
function openAICompatible({ name, base, modelsUrl, exclude, pickDefault, extraHeaders = {}, billingHint }) {
  const headers = (key) => ({ "Content-Type": "application/json", Authorization: "Bearer " + key, ...extraHeaders });
  async function fail(res) {
    let detail = "";
    try { const j = await res.json(); detail = j.error?.message || j.message || j.detail || ""; } catch {}
    if (res.status === 401) return new ProviderError(`La chiave ${name} non è valida. Controllala nelle Impostazioni.`);
    if (res.status === 402) return new ProviderError(`Credito ${name} esaurito. ${billingHint}`);
    if (res.status === 403) return new ProviderError(`La chiave ${name} non ha accesso a questo modello.`);
    if (res.status === 429) return new ProviderError(`${name}: troppe richieste o limite raggiunto. Riprova tra poco. ${billingHint}`);
    return new ProviderError(`Errore di ${name} (${res.status}): ${detail || res.statusText}`);
  }
  return {
    async listModels(key) {
      const res = await fetch(modelsUrl || base + "/models", { headers: headers(key) });
      if (!res.ok) throw await fail(res);
      const { data = [] } = await res.json();
      return data
        .filter((m) => !exclude.test(m.id))
        .map((m) => ({ id: m.id, label: m.name || m.id }))
        .sort((a, b) => a.label.localeCompare(b.label));
    },
    pickDefault,
    async chat({ key, model, system, history, onText }) {
      const res = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: headers(key),
        body: JSON.stringify({
          model,
          stream: true,
          messages: [{ role: "system", content: system }, ...history.map((m) => ({ role: m.role, content: m.text }))],
        }),
      });
      if (!res.ok) throw await fail(res);
      let text = "";
      await readSSE(res, (chunk) => {
        if (chunk.error) throw new ProviderError(`Errore di ${name}: ${chunk.error.message || "risposta interrotta"}`);
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) { text += choice.delta.content; onText(text); }
        if (choice?.finish_reason === "content_filter") text += "\n\n" + REFUSAL;
      });
      return { text, sources: [] };
    },
  };
}

// Righe "data: {...}" di uno stream SSE; ignora "[DONE]" e righe non JSON.
async function readSSE(res, onChunk) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      onChunk(chunk);
    }
  }
}

const NOT_CHAT = /(embed|whisper|tts|transcri|audio|realtime|image|dall-e|moderation|guard|ocr|speech|vision-preview|search|computer-use|instruct|babbage|davinci|codex|playai|orpheus|imagine|video)/i;

export const PROVIDERS = {
  gemini: {
    name: "Gemini", vendor: "Google", web: true,
    note: "Gratuito per un uso normale",
    keyUrl: "https://aistudio.google.com/apikey",
    steps: ["Accedi con il tuo account Google", "Tocca <em>Create API key</em> e copiala"],
    impl: gemini,
  },
  claude: {
    name: "Claude", vendor: "Anthropic", web: true,
    note: "A consumo, pochi euro al mese",
    keyUrl: "https://console.anthropic.com/settings/keys",
    steps: ["Crea un account e in <em>Billing</em> aggiungi qualche euro", "In <em>API keys</em> tocca <em>Create key</em> e copiala"],
    warn: "L'abbonamento Claude Pro/Max non vale qui: serve una chiave API.",
    impl: claude,
  },
  openai: {
    name: "ChatGPT", vendor: "OpenAI", web: false,
    note: "A consumo",
    keyUrl: "https://platform.openai.com/api-keys",
    steps: ["Accedi e in <em>Billing</em> aggiungi qualche euro", "Tocca <em>Create new secret key</em> e copiala"],
    warn: "L'abbonamento ChatGPT Plus non vale qui: serve una chiave API.",
    impl: openAICompatible({
      name: "OpenAI", base: "https://api.openai.com/v1",
      exclude: new RegExp(NOT_CHAT.source + "|^(?!gpt-|o\\d|chatgpt)|-\\d{4}-\\d{2}-\\d{2}$", "i"),
      pickDefault: (m) => firstMatch(m, /^gpt-\d+(\.\d+)?$/, /^gpt-\d+(\.\d+)?-mini$/, /^gpt-/),
      billingHint: "Controlla il credito su platform.openai.com.",
    }),
  },
  mistral: {
    name: "Mistral", vendor: "Mistral AI · Europa", web: false,
    note: "Piano gratuito disponibile",
    keyUrl: "https://console.mistral.ai/api-keys",
    steps: ["Crea un account e scegli il piano <em>Experiment</em> (gratuito)", "Crea una chiave API e copiala"],
    impl: openAICompatible({
      name: "Mistral", base: "https://api.mistral.ai/v1",
      exclude: new RegExp(NOT_CHAT.source + "|^(?!.*latest$)", "i"),
      pickDefault: (m) => firstMatch(m, /^mistral-large-latest$/, /^mistral-medium-latest$/, /^mistral-small-latest$/),
      billingHint: "Controlla il piano su console.mistral.ai.",
    }),
  },
  groq: {
    name: "Groq", vendor: "Modelli open, velocissimi", web: false,
    note: "Gratuito con limiti",
    keyUrl: "https://console.groq.com/keys",
    steps: ["Accedi con Google o email", "Tocca <em>Create API Key</em> e copiala"],
    impl: openAICompatible({
      name: "Groq", base: "https://api.groq.com/openai/v1",
      exclude: NOT_CHAT,
      pickDefault: (m) => firstMatch(m, /gpt-oss-120b/, /llama.*70b/, /llama/),
      billingHint: "Il piano gratuito ha limiti al minuto.",
    }),
  },
  deepseek: {
    name: "DeepSeek", vendor: "DeepSeek", web: false,
    note: "Molto economico",
    keyUrl: "https://platform.deepseek.com/api_keys",
    steps: ["Crea un account e ricarica qualche euro", "Crea una chiave API e copiala"],
    impl: openAICompatible({
      name: "DeepSeek", base: "https://api.deepseek.com",
      exclude: NOT_CHAT,
      pickDefault: (m) => firstMatch(m, /^deepseek-chat$/),
      billingHint: "Ricarica su platform.deepseek.com.",
    }),
  },
  xai: {
    name: "Grok", vendor: "xAI", web: false,
    note: "A consumo",
    keyUrl: "https://console.x.ai",
    steps: ["Accedi e aggiungi credito", "In <em>API Keys</em> crea una chiave e copiala"],
    impl: openAICompatible({
      name: "xAI", base: "https://api.x.ai/v1",
      exclude: NOT_CHAT,
      pickDefault: (m) => firstMatch(m, /^grok-\d+(\.\d+)?$/, /^grok-\d/, /^grok/),
      billingHint: "Controlla il credito su console.x.ai.",
    }),
  },
  openrouter: {
    name: "OpenRouter", vendor: "Centinaia di modelli, una chiave", web: false,
    note: "Alcuni modelli gratis",
    keyUrl: "https://openrouter.ai/keys",
    steps: ["Accedi con Google o GitHub", "Tocca <em>Create Key</em> e copiala"],
    impl: openAICompatible({
      name: "OpenRouter", base: "https://openrouter.ai/api/v1",
      exclude: NOT_CHAT,
      pickDefault: (m) => firstMatch(m, /^openrouter\/auto$/),
      extraHeaders: { "X-Title": "Jarvis" },
      billingHint: "Ricarica su openrouter.ai/credits oppure scegli un modello \":free\".",
    }),
  },
};

// OpenRouter elenca i modelli anche senza chiave: la verifichiamo a parte.
const orList = PROVIDERS.openrouter.impl.listModels;
PROVIDERS.openrouter.impl.listModels = async (key) => {
  const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: "Bearer " + key } });
  if (res.status === 401) throw new ProviderError("La chiave OpenRouter non è valida. Controllala nelle Impostazioni.");
  return [{ id: "openrouter/auto", label: "Automatico (sceglie OpenRouter)" }, ...(await orList(key))];
};
