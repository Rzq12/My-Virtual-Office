import { OpenAICompatibleAdapter } from '../OpenAICompatibleAdapter';

describe('OpenAICompatibleAdapter', () => {
    const realFetch = global.fetch;
    let calls: Array<{ url: string; init: any }>;

    function mockFetch(status: number, body: any) {
        calls = [];
        global.fetch = jest.fn(async (url: any, init: any) => {
            calls.push({ url: String(url), init });
            return {
                ok: status >= 200 && status < 300,
                status,
                statusText: status === 200 ? 'OK' : 'Error',
                json: async () => body,
                text: async () => JSON.stringify(body)
            } as any;
        }) as any;
    }

    afterEach(() => {
        global.fetch = realFetch;
    });

    it.each([
        ['https://api.openai.com', 'https://api.openai.com/v1'],
        ['https://api.openai.com/v1/', 'https://api.openai.com/v1'],
        ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1'],
        ['https://api.groq.com/openai/v1', 'https://api.groq.com/openai/v1'],
        ['http://localhost:1234', 'http://localhost:1234/v1']
    ])('normalizes %s', (input, expected) => {
        expect(OpenAICompatibleAdapter.normalizeBaseUrl(input)).toBe(expected);
    });

    it('sends a chat completion with the model and bearer key', async () => {
        mockFetch(200, { choices: [{ message: { content: '{"action":"work"}' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
        const adapter = new OpenAICompatibleAdapter('https://example.test/v1', 'sk-test');
        const res = await adapter.complete({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 });

        expect(calls[0].url).toBe('https://example.test/v1/chat/completions');
        expect(calls[0].init.headers.Authorization).toBe('Bearer sk-test');
        expect(JSON.parse(calls[0].init.body)).toMatchObject({ model: 'gpt-4o-mini', temperature: 0.7 });
        expect(res.content).toBe('{"action":"work"}');
        expect(res.usage).toEqual({ prompt: 3, completion: 2 });
    });

    it('omits the Authorization header without a key (local servers)', async () => {
        mockFetch(200, { choices: [{ message: { content: 'ok' } }] });
        await new OpenAICompatibleAdapter('http://localhost:1234', '').complete({ model: 'local', messages: [] });
        expect(calls[0].init.headers.Authorization).toBeUndefined();
    });

    it('includes the response body in errors', async () => {
        mockFetch(401, { error: { message: 'Invalid API key' } });
        await expect(new OpenAICompatibleAdapter('https://example.test', 'bad').complete({ model: 'm', messages: [] }))
            .rejects.toThrow(/401.*Invalid API key/);
    });

    it('lists unique, sorted model ids', async () => {
        mockFetch(200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] });
        expect(await new OpenAICompatibleAdapter('https://example.test', 'k').listModels()).toEqual(['gpt-4o', 'gpt-4o-mini']);
        expect(calls[0].url).toBe('https://example.test/v1/models');
    });

    it('returns embeddings', async () => {
        mockFetch(200, { data: [{ embedding: [0.1, 0.2] }] });
        expect(await new OpenAICompatibleAdapter('https://example.test', 'k').embedWith('text-embedding-3-small', 'hello')).toEqual([0.1, 0.2]);
    });
});
