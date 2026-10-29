import { validateChoice, defaultChoice, describeEngine, providerInfo } from '../llm';

const ENV_KEYS = ['LLM_PROVIDER', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'CLAUDE_MODEL', 'CODEX_MODEL', 'CLAUDE_CLI', 'CODEX_CLI'];

describe('llm provider selection', () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
        // `node` is always on PATH, so both CLI providers count as installed unless a test says otherwise.
        process.env.CLAUDE_CLI = 'node';
        process.env.CODEX_CLI = 'node';
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    it('offers claude, chatgpt and openai — and no ollama', () => {
        expect(providerInfo().map(p => p.id)).toEqual(['claude', 'chatgpt', 'openai']);
    });

    it('marks the OpenAI-compatible provider unavailable until a base URL is set', () => {
        expect(providerInfo().find(p => p.id === 'openai')?.available).toBe(false);
        expect(validateChoice({ provider: 'openai', model: 'gpt-4o-mini' })).toMatch(/not configured/);

        process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1';
        const openai = providerInfo().find(p => p.id === 'openai')!;
        expect(openai.available).toBe(true);
        expect(openai.label).toContain('openrouter.ai');
        expect(validateChoice({ provider: 'openai', model: 'meta-llama/llama-3.1-8b-instruct:free' }))
            .toEqual({ provider: 'openai', model: 'meta-llama/llama-3.1-8b-instruct:free' });
        expect(validateChoice({ provider: 'openai', model: 'cx/gpt-6-sol[1m]' }))
            .toEqual({ provider: 'openai', model: 'cx/gpt-6-sol[1m]' });
    });

    it('rejects unknown providers and unsafe model ids', () => {
        expect(validateChoice({ provider: 'ollama', model: 'llama3.2' })).toMatch(/Unknown provider/);
        expect(validateChoice({ provider: 'chatgpt', model: 'gpt-5" && calc' })).toMatch(/not a valid model/);
        expect(validateChoice({ provider: 'claude', model: '$(whoami)' })).toMatch(/not a valid model/);
    });

    it('fills in the default model when none is given', () => {
        process.env.CLAUDE_MODEL = 'sonnet';
        expect(validateChoice({ provider: 'claude', model: '' })).toEqual({ provider: 'claude', model: 'sonnet' });
        expect(validateChoice({ provider: 'chatgpt', model: '' })).toEqual({ provider: 'chatgpt', model: '' });
    });

    it('picks defaults from LLM_PROVIDER and falls back to Claude', () => {
        process.env.LLM_PROVIDER = 'mixed';
        expect([0, 1, 2].map(i => defaultChoice(i).provider)).toEqual(['claude', 'chatgpt', 'claude']);

        process.env.LLM_PROVIDER = 'openai';
        expect(defaultChoice(0).provider).toBe('claude'); // not configured yet
        process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
        process.env.OPENAI_MODEL = 'gpt-4o-mini';
        expect(defaultChoice(0)).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });

        process.env.LLM_PROVIDER = 'ollama';
        expect(defaultChoice(0).provider).toBe('claude');
    });

    it('marks a CLI provider unavailable when its command is missing and falls back', () => {
        process.env.CODEX_CLI = 'definitely-not-installed-cli-xyz';
        const chatgpt = providerInfo().find(p => p.id === 'chatgpt')!;
        expect(chatgpt.available).toBe(false);
        expect(chatgpt.hint).toMatch(/npm i -g @openai\/codex/);
        expect(validateChoice({ provider: 'chatgpt', model: '' })).toMatch(/not configured/);

        process.env.LLM_PROVIDER = 'mixed';
        expect([0, 1].map(i => defaultChoice(i).provider)).toEqual(['claude', 'claude']);
    });

    it('summarises the team for the header', () => {
        expect(describeEngine([{ provider: 'claude', model: 'haiku' }, { provider: 'claude', model: 'haiku' }])).toBe('Claude · haiku');
        expect(describeEngine([
            { provider: 'claude', model: 'haiku' },
            { provider: 'claude', model: 'sonnet' },
            { provider: 'openai', model: 'gpt-4o-mini' }
        ])).toBe('Claude ×2 · OpenAI-compatible ×1');
    });
});
