// LLM client — thin OpenAI-chat-compatible wrapper.
//
// Default base URL is OpenAI but anything chat-completions-compatible
// (Anthropic via gateway, OpenRouter, Together, vLLM, etc.) plugs in via
// LLM_BASE_URL.
//
// Env:
//   LLM_API_KEY    required
//   LLM_BASE_URL   default https://api.openai.com/v1
//   LLM_MODEL      default gpt-4o-mini  (fast + JSON-mode capable)

import type { LLMClient } from "./agent";

export class HttpLLMClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts?: { baseUrl?: string; apiKey?: string; model?: string }) {
    this.baseUrl = (opts?.baseUrl ?? process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const key = opts?.apiKey ?? process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error("LLM_API_KEY (or OPENAI_API_KEY) is not set");
    }
    this.apiKey = key;
    this.model = opts?.model ?? process.env.LLM_MODEL ?? "gpt-4o-mini";
  }

  async complete(opts: {
    system: string;
    user: string;
    json?: boolean;
    maxTokens?: number;
  }): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      max_tokens: opts.maxTokens ?? 600,
      temperature: 0.4,
    };
    if (opts.json) {
      body.response_format = { type: "json_object" };
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(`LLM returned no content: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return content;
  }
}

/** Lazy singleton — call from server-side route handlers. */
let _llm: HttpLLMClient | null = null;
export function getLLM(): HttpLLMClient {
  if (!_llm) _llm = new HttpLLMClient();
  return _llm;
}
