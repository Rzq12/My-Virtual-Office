import { InferenceAdapter, CompletionRequest, CompletionResponse } from '@agent-office/core';

/**
 * Talks to any OpenAI-compatible HTTP API (OpenAI, OpenRouter, Groq, Together, LM Studio, vLLM, ...).
 * `baseUrl` may be given with or without the trailing `/v1`.
 */
export class OpenAICompatibleAdapter implements InferenceAdapter {
    public readonly isLocal = false;
    private readonly apiBase: string;

    constructor(
        baseUrl: string,
        private apiKey: string,
        public readonly provider: string = 'openai',
        private timeoutMs: number = 120000
    ) {
        this.apiBase = OpenAICompatibleAdapter.normalizeBaseUrl(baseUrl);
    }

    /** "https://api.openai.com" and "https://api.openai.com/v1/" both become "https://api.openai.com/v1". */
    static normalizeBaseUrl(baseUrl: string): string {
        const trimmed = baseUrl.trim().replace(/\/+$/, '');
        return /\/v\d+(beta)?$/.test(trimmed) || /\/openai$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
    }

    private headers(): Record<string, string> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
        return headers;
    }

    private async request(path: string, init: RequestInit): Promise<any> {
        const response = await fetch(`${this.apiBase}${path}`, {
            ...init,
            headers: this.headers(),
            signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`OpenAI-compatible API ${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
        }
        return response.json();
    }

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
        const start = Date.now();

        const tools = request.tools ? request.tools.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters
            }
        })) : undefined;

        const data = await this.request('/chat/completions', {
            method: 'POST',
            body: JSON.stringify({
                model: request.model,
                messages: request.messages,
                tools,
                temperature: request.temperature,
                max_tokens: request.maxTokens
            })
        });

        const message = data.choices?.[0]?.message;
        if (!message) throw new Error('OpenAI-compatible API returned no choices.');

        let toolCalls;
        if (message.tool_calls) {
            toolCalls = message.tool_calls.map((tc: any) => ({
                name: tc.function.name,
                params: safeJson(tc.function.arguments)
            }));
        }

        return {
            content: message.content || '',
            toolCalls,
            usage: {
                prompt: data.usage?.prompt_tokens || 0,
                completion: data.usage?.completion_tokens || 0
            },
            latency: Date.now() - start
        };
    }

    async listModels(): Promise<string[]> {
        const data = await this.request('/models', { method: 'GET' });
        const ids = (Array.isArray(data?.data) ? data.data : []).map((m: any) => String(m.id || '')).filter(Boolean);
        return Array.from(new Set<string>(ids)).sort();
    }

    /** Embeddings for semantic memory search. `model` must be an embedding model on this endpoint. */
    async embedWith(model: string, text: string): Promise<number[]> {
        const data = await this.request('/embeddings', {
            method: 'POST',
            body: JSON.stringify({ model, input: text })
        });
        const vector = data?.data?.[0]?.embedding;
        if (!Array.isArray(vector)) throw new Error('OpenAI-compatible API returned no embedding.');
        return vector;
    }
}

function safeJson(text: unknown): any {
    try {
        return typeof text === 'string' ? JSON.parse(text) : text || {};
    } catch {
        return {};
    }
}
