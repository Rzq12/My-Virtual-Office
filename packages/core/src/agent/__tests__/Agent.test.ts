import { Agent, parseDecisionJson } from '../Agent';

describe('parseDecisionJson', () => {
    it('reads JSON wrapped in prose and code fences', () => {
        const reply = 'Sure!\n```json\n{"thought":"ok","action":"work"}\n```\nLet me know {if} you need more.';
        expect(parseDecisionJson(reply)).toEqual({ thought: 'ok', action: 'work' });
    });

    it('repairs invalid backslash escapes from code snippets', () => {
        const reply = '{"action":"use_tool","toolCall":{"name":"code_execute","params":{"code":"return /\\d+/.test(\'42\')"}}}';
        const parsed = parseDecisionJson(reply.replace('\\\\d', '\\d'));
        expect(parsed?.action).toBe('use_tool');
        expect(parsed?.toolCall.params.code).toContain('\\d+');
    });

    it('recovers the string fields when the JSON is broken', () => {
        const reply = '{"thought":"answer the user","action":"talk","target":"User","message":"Halo!" "oops": }';
        expect(parseDecisionJson(reply)).toEqual({ thought: 'answer the user', action: 'talk', target: 'User', message: 'Halo!' });
    });

    it('returns null when there is no decision', () => {
        expect(parseDecisionJson('I cannot help with that.')).toBeNull();
    });
});

function makeAgent(limit: number) {
    return new Agent({
        id: 'a', name: 'A', role: 'Engineer', avatar: '',
        inference: { provider: 'openai', model: 'x' },
        personality: {
            traits: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 },
            communicationStyle: 'technical',
            workHours: { start: '09:00', end: '17:00' },
            breakFrequency: 60
        },
        capabilities: [],
        memory: { shortTermLimit: limit }
    } as any);
}

describe('Agent memory', () => {
    it('keeps chronological order when trimming, so recent memories stay recent', () => {
        const agent = makeAgent(3);
        agent.addMemory({ content: 'old important', type: 'achievement', timestamp: '1', importance: 0.9 });
        agent.addMemory({ content: 'old trivial', type: 'thought', timestamp: '2', importance: 0.1 });
        agent.addMemory({ content: 'middle', type: 'thought', timestamp: '3', importance: 0.3 });
        agent.addMemory({ content: 'newest', type: 'thought', timestamp: '4', importance: 0.2 });

        expect(agent.memories.map(m => m.content)).toEqual(['old important', 'middle', 'newest']);
        expect(agent.getRecentMemories(1)).toEqual(['[thought] newest']);
    });

    it('never drops the memory that was just added', () => {
        const agent = makeAgent(2);
        agent.addMemory({ content: 'a', type: 'achievement', timestamp: '1', importance: 0.9 });
        agent.addMemory({ content: 'b', type: 'achievement', timestamp: '2', importance: 0.9 });
        agent.addMemory({ content: 'c', type: 'thought', timestamp: '3', importance: 0.01 });
        expect(agent.memories.map(m => m.content)).toEqual(['b', 'c']);
    });
});
