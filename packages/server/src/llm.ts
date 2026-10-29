import { InferenceAdapter, AgentConfig } from '@agent-office/core';
import { OllamaAdapter, ClaudeCliAdapter, CodexCliAdapter } from '@agent-office/adapters';

/**
 * LLM_PROVIDER selects which brain the agents use:
 *   claude  — Claude via the logged-in Claude Code CLI (`claude`)
 *   chatgpt — ChatGPT via the logged-in Codex CLI (`codex`)
 *   mixed   — agents alternate between Claude and ChatGPT (default)
 *   ollama  — local Ollama (original behaviour)
 */
type Brain = { adapter: InferenceAdapter; inference: Pick<AgentConfig['inference'], 'provider' | 'model'>; label: string };

const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 120000);

const brains: Record<'claude' | 'chatgpt' | 'ollama', () => Brain> = {
    claude: () => ({
        adapter: new ClaudeCliAdapter(process.env.CLAUDE_CLI || 'claude', timeoutMs),
        inference: { provider: 'anthropic', model: process.env.CLAUDE_MODEL || 'haiku' },
        label: 'Claude'
    }),
    chatgpt: () => ({
        adapter: new CodexCliAdapter(process.env.CODEX_CLI || 'codex', timeoutMs),
        inference: { provider: 'openai', model: process.env.CODEX_MODEL || '' },
        label: 'ChatGPT'
    }),
    ollama: () => ({
        adapter: new OllamaAdapter(process.env.OLLAMA_URL || 'http://localhost:11434'),
        inference: { provider: 'ollama', model: process.env.OLLAMA_MODEL || 'llama3.2:latest' },
        label: 'Ollama'
    })
};

const cache = new Map<string, Brain>();
let assigned = 0;

/** Returns the brain for the next agent that is created. */
export function nextBrain(): Brain {
    const setting = (process.env.LLM_PROVIDER || 'mixed').toLowerCase();
    let key: keyof typeof brains;
    if (setting === 'mixed') {
        key = assigned++ % 2 === 0 ? 'claude' : 'chatgpt';
    } else if (setting in brains) {
        key = setting as keyof typeof brains;
    } else {
        throw new Error(`Unknown LLM_PROVIDER "${setting}". Use claude, chatgpt, mixed or ollama.`);
    }
    if (!cache.has(key)) cache.set(key, brains[key]());
    return cache.get(key)!;
}

export const THINK_COOLDOWN_MS = Number(process.env.THINK_COOLDOWN_MS || 15000);
