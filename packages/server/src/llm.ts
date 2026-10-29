import { InferenceAdapter, AgentConfig } from '@agent-office/core';
import { OpenAICompatibleAdapter, ClaudeCliAdapter, CodexCliAdapter } from '@agent-office/adapters';
import { spawnSync } from 'child_process';

/**
 * Brains an agent can use. Each agent picks one provider + model (changeable from the UI):
 *   claude  — Claude via the logged-in Claude Code CLI (`claude`)
 *   chatgpt — ChatGPT via the logged-in Codex CLI (`codex`)
 *   openai  — any OpenAI-compatible HTTP API (OPENAI_BASE_URL + OPENAI_API_KEY)
 * LLM_PROVIDER sets the default for agents without a saved choice ("mixed" alternates claude/chatgpt).
 */
export type ProviderId = 'claude' | 'chatgpt' | 'openai';
export const PROVIDER_IDS: ProviderId[] = ['claude', 'chatgpt', 'openai'];

export interface BrainChoice {
    provider: ProviderId;
    model: string;
}

export interface ProviderInfo {
    id: ProviderId;
    label: string;
    available: boolean;
    /** Why the provider cannot be used, when it is not available. */
    hint?: string;
    defaultModel: string;
    /** Suggestions for the model field; any valid model id may be typed. */
    models: string[];
}

export type Brain = {
    adapter: InferenceAdapter;
    inference: Pick<AgentConfig['inference'], 'provider' | 'model'>;
    label: string;
    choice: BrainChoice;
};

const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 120000);

// Model ids like "haiku", "gpt-4o-mini", "anthropic/claude-3.5-sonnet", "llama-3.1-8b-instant:free", "cx/gpt-6-sol[1m]".
// Restricting the characters (no quotes, spaces, &|<>^%$`) also keeps the value safe when a CLI is launched through a shell.
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$/;

function list(value: string | undefined): string[] {
    return (value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function openaiBaseUrl(): string {
    return (process.env.OPENAI_BASE_URL || '').trim();
}

function openaiHost(): string {
    try {
        return new URL(openaiBaseUrl()).host;
    } catch {
        return '';
    }
}

let openaiModelCache: string[] | null = null;
const cliCache = new Map<string, boolean>();

/** Whether a CLI can be launched (looked up once per command; npm shims on Windows are found too). */
export function isCliInstalled(command: string): boolean {
    if (!cliCache.has(command)) {
        const finder = process.platform === 'win32' ? 'where' : 'which';
        const result = spawnSync(finder, [command], { windowsHide: true, timeout: 10000 });
        cliCache.set(command, result.status === 0);
    }
    return cliCache.get(command)!;
}

export function providerInfo(): ProviderInfo[] {
    const host = openaiHost();
    const claudeCli = process.env.CLAUDE_CLI || 'claude';
    const codexCli = process.env.CODEX_CLI || 'codex';
    const claudeReady = isCliInstalled(claudeCli);
    const codexReady = isCliInstalled(codexCli);
    return [
        {
            id: 'claude',
            label: 'Claude (Claude Code login)',
            available: claudeReady,
            hint: claudeReady ? undefined : `"${claudeCli}" was not found on PATH. Install Claude Code and run \`claude\` once to log in.`,
            defaultModel: process.env.CLAUDE_MODEL || 'haiku',
            models: list(process.env.CLAUDE_MODELS).length ? list(process.env.CLAUDE_MODELS) : ['haiku', 'sonnet', 'opus']
        },
        {
            id: 'chatgpt',
            label: 'ChatGPT (Codex CLI login)',
            available: codexReady,
            hint: codexReady ? undefined : `"${codexCli}" was not found on PATH. Run \`npm i -g @openai/codex\` and \`codex login\`.`,
            defaultModel: process.env.CODEX_MODEL || '',
            models: list(process.env.CODEX_MODELS)
        },
        {
            id: 'openai',
            label: host ? `OpenAI-compatible (${host})` : 'OpenAI-compatible API',
            available: Boolean(host),
            hint: host ? undefined : 'Set OPENAI_BASE_URL (and OPENAI_API_KEY) in .env, then restart the server.',
            defaultModel: process.env.OPENAI_MODEL || openaiModelCache?.[0] || '',
            models: openaiModelCache || list(process.env.OPENAI_MODELS)
        }
    ];
}

const adapters = new Map<ProviderId, InferenceAdapter>();

function adapterFor(provider: ProviderId): InferenceAdapter {
    let adapter = adapters.get(provider);
    if (adapter) return adapter;
    if (provider === 'claude') {
        adapter = new ClaudeCliAdapter(process.env.CLAUDE_CLI || 'claude', timeoutMs);
    } else if (provider === 'chatgpt') {
        adapter = new CodexCliAdapter(process.env.CODEX_CLI || 'codex', timeoutMs);
    } else {
        adapter = new OpenAICompatibleAdapter(openaiBaseUrl(), process.env.OPENAI_API_KEY || '', 'openai', timeoutMs);
    }
    adapters.set(provider, adapter);
    return adapter;
}

/** Loads the model list from the OpenAI-compatible endpoint (falls back to OPENAI_MODELS). */
export async function refreshOpenAIModels(): Promise<void> {
    if (!openaiBaseUrl()) return;
    try {
        const models = await (adapterFor('openai') as OpenAICompatibleAdapter).listModels();
        if (models.length > 0) openaiModelCache = models.slice(0, 300);
    } catch (err: any) {
        console.warn(`[LLM] Could not list models from ${openaiHost()}: ${err.message}`);
    }
}

/** Validates a choice coming from the UI. Returns an error message instead of a choice when invalid. */
export function validateChoice(raw: unknown): BrainChoice | string {
    const value = (raw || {}) as { provider?: unknown; model?: unknown };
    const provider = String(value.provider || '') as ProviderId;
    const info = providerInfo().find(p => p.id === provider);
    if (!info) return `Unknown provider "${provider}".`;
    if (!info.available) return `${info.label} is not configured. ${info.hint || ''}`.trim();

    const model = typeof value.model === 'string' ? value.model.trim() : '';
    if (!model) {
        // The Codex CLI picks its own default model; the other providers need a model id.
        if (provider === 'chatgpt') return { provider, model: '' };
        if (!info.defaultModel) return `Choose a model for ${info.label}.`;
        return { provider, model: info.defaultModel };
    }
    if (!MODEL_PATTERN.test(model)) return `"${model}" is not a valid model id.`;
    return { provider, model };
}

/** Default brain for the n-th agent when nothing was saved for it. */
export function defaultChoice(index: number): BrainChoice {
    const setting = (process.env.LLM_PROVIDER || 'claude').toLowerCase();
    let provider: ProviderId;
    if (setting === 'mixed') {
        provider = index % 2 === 0 ? 'claude' : 'chatgpt';
    } else if ((PROVIDER_IDS as string[]).includes(setting)) {
        provider = setting as ProviderId;
    } else {
        console.warn(`[LLM] Unknown LLM_PROVIDER "${setting}" — using claude. Valid values: claude, chatgpt, openai, mixed.`);
        provider = 'claude';
    }
    const providers = providerInfo();
    const info = providers.find(p => p.id === provider)!;
    if (info.available && (provider !== 'openai' || info.defaultModel)) return { provider, model: info.defaultModel };

    // Fall back to the first provider that can actually run (Claude first, then the API, then Codex).
    const fallback = ['claude', 'openai', 'chatgpt']
        .map(id => providers.find(p => p.id === id)!)
        .find(p => p.available && (p.id !== 'openai' || p.defaultModel)) || providers[0];
    console.warn(`[LLM] ${info.label} is not usable (${info.hint || 'no default model'}) — using ${fallback.label}.`);
    return { provider: fallback.id, model: fallback.defaultModel };
}

export function brainFor(choice: BrainChoice): Brain {
    return {
        adapter: adapterFor(choice.provider),
        inference: {
            provider: choice.provider === 'claude' ? 'anthropic' : 'openai',
            model: choice.model
        },
        label: labelFor(choice),
        choice
    };
}

export function labelFor(choice: BrainChoice): string {
    const name = choice.provider === 'claude' ? 'Claude' : choice.provider === 'chatgpt' ? 'ChatGPT' : 'OpenAI-compatible';
    return `${name} · ${choice.model || 'default'}`;
}

/** Short summary of the team's brains for the UI header, e.g. "Claude ×7 · OpenAI-compatible ×3". */
export function describeEngine(choices: BrainChoice[]): string {
    const counts = new Map<string, number>();
    for (const choice of choices) {
        const name = labelFor(choice).split(' · ')[0];
        counts.set(name, (counts.get(name) || 0) + 1);
    }
    const sameEverywhere = choices.length > 0 && choices.every(c => c.provider === choices[0].provider && c.model === choices[0].model);
    if (sameEverywhere) return labelFor(choices[0]);
    return Array.from(counts.entries()).map(([name, n]) => `${name} ×${n}`).join(' · ');
}

/** Embedding function for semantic memory, if OPENAI_EMBEDDING_MODEL is set on an OpenAI-compatible endpoint. */
export function createEmbedder(): ((text: string) => Promise<number[] | null>) | undefined {
    const model = (process.env.OPENAI_EMBEDDING_MODEL || '').trim();
    if (!model || !openaiBaseUrl()) return undefined;
    return async (text: string) => {
        try {
            return await (adapterFor('openai') as OpenAICompatibleAdapter).embedWith(model, text);
        } catch {
            return null;
        }
    };
}

export const THINK_COOLDOWN_MS = Number(process.env.THINK_COOLDOWN_MS || 15000);

/** How many agents may wait on the LLM at the same time. Keeps a 10-agent office from bursting your quota. */
export const MAX_CONCURRENT_THINKS = Math.max(1, Number(process.env.MAX_CONCURRENT_THINKS || 3));
