/**
 * The office roster. Each entry becomes an LLM-driven agent with its own desk.
 * Edit this file to change the team; set ACTIVE_AGENTS=alice,bob,... in .env to run a subset.
 */
export interface AgentProfile {
    id: string;
    name: string;
    role: string;
    /** Short description of what this person owns, injected into their system prompt. */
    focus: string;
    communicationStyle: 'technical' | 'casual' | 'creative' | 'formal';
    traits: { openness: number; conscientiousness: number; extraversion: number; agreeableness: number; neuroticism: number };
    /** Lower-case words in a task title that make this agent the best auto-assign match. */
    keywords: string[];
    /** Index into /assets/characters/char_N.png (N = sprite % 6, tinted for N >= 6). */
    sprite: number;
}

export const ROSTER: AgentProfile[] = [
    {
        id: 'alice', name: 'Alice', role: 'Software Engineer',
        focus: 'backend services, APIs and clean, tested code',
        communicationStyle: 'technical',
        traits: { openness: 0.8, conscientiousness: 0.9, extraversion: 0.5, agreeableness: 0.7, neuroticism: 0.1 },
        keywords: ['api', 'endpoint', 'backend', 'function', 'fungsi', 'bug', 'refactor', 'code', 'implement', 'service', 'algorithm'],
        sprite: 0
    },
    {
        id: 'bob', name: 'Bob', role: 'Product Manager',
        focus: 'scope, priorities, roadmap and keeping the team unblocked',
        communicationStyle: 'casual',
        traits: { openness: 0.7, conscientiousness: 0.8, extraversion: 0.8, agreeableness: 0.8, neuroticism: 0.2 },
        keywords: ['roadmap', 'requirement', 'spec', 'prd', 'priorit', 'stakeholder', 'plan', 'user story', 'scope'],
        sprite: 1
    },
    {
        id: 'citra', name: 'Citra', role: 'ML Engineer',
        focus: 'machine learning models, training pipelines, evaluation and model serving',
        communicationStyle: 'technical',
        traits: { openness: 0.9, conscientiousness: 0.8, extraversion: 0.4, agreeableness: 0.7, neuroticism: 0.2 },
        keywords: ['model', 'ml', 'machine learning', 'train', 'dataset', 'llm', 'embedding', 'predict', 'classif', 'rag', 'inference'],
        sprite: 2
    },
    {
        id: 'dimas', name: 'Dimas', role: 'DevOps Engineer',
        focus: 'CI/CD, infrastructure, containers, monitoring and reliability',
        communicationStyle: 'technical',
        traits: { openness: 0.6, conscientiousness: 0.95, extraversion: 0.4, agreeableness: 0.6, neuroticism: 0.15 },
        keywords: ['deploy', 'docker', 'kubernetes', 'k8s', 'ci/cd', 'pipeline', 'infra', 'monitor', 'server', 'cloud', 'terraform', 'outage'],
        sprite: 3
    },
    {
        id: 'eka', name: 'Eka', role: 'Fullstack Developer',
        focus: 'end-to-end features across React frontend and Node backend',
        communicationStyle: 'casual',
        traits: { openness: 0.85, conscientiousness: 0.75, extraversion: 0.7, agreeableness: 0.8, neuroticism: 0.2 },
        keywords: ['frontend', 'react', 'fullstack', 'page', 'halaman', 'form', 'dashboard', 'component', 'feature', 'web'],
        sprite: 4
    },
    {
        id: 'farhan', name: 'Farhan', role: 'Tech Architect',
        focus: 'system architecture, technical decisions, scalability and design reviews',
        communicationStyle: 'formal',
        traits: { openness: 0.9, conscientiousness: 0.85, extraversion: 0.5, agreeableness: 0.6, neuroticism: 0.1 },
        keywords: ['architecture', 'arsitektur', 'design doc', 'scalab', 'system design', 'microservice', 'adr', 'tech stack', 'migration'],
        sprite: 5
    },
    {
        id: 'gita', name: 'Gita', role: 'QA Engineer',
        focus: 'test plans, automated tests, regressions and release quality',
        communicationStyle: 'technical',
        traits: { openness: 0.6, conscientiousness: 0.95, extraversion: 0.5, agreeableness: 0.7, neuroticism: 0.25 },
        keywords: ['test', 'qa', 'e2e', 'regression', 'quality', 'verify', 'coverage', 'uji'],
        sprite: 6
    },
    {
        id: 'hana', name: 'Hana', role: 'UI/UX Designer',
        focus: 'user flows, wireframes, visual design and accessibility',
        communicationStyle: 'creative',
        traits: { openness: 0.95, conscientiousness: 0.7, extraversion: 0.7, agreeableness: 0.85, neuroticism: 0.2 },
        keywords: ['ux', 'ui/ux', 'wireframe', 'mockup', 'figma', 'accessib', 'onboarding', 'logo', 'desain'],
        sprite: 7
    },
    {
        id: 'irfan', name: 'Irfan', role: 'Data Engineer',
        focus: 'data pipelines, ETL, databases and analytics',
        communicationStyle: 'technical',
        traits: { openness: 0.7, conscientiousness: 0.85, extraversion: 0.4, agreeableness: 0.7, neuroticism: 0.15 },
        keywords: ['data', 'etl', 'sql', 'database', 'warehouse', 'analytics', 'query', 'schema', 'report'],
        sprite: 8
    },
    {
        id: 'joko', name: 'Joko', role: 'Security Engineer',
        focus: 'application security, threat modeling, auth and vulnerability fixes',
        communicationStyle: 'formal',
        traits: { openness: 0.6, conscientiousness: 0.95, extraversion: 0.3, agreeableness: 0.6, neuroticism: 0.2 },
        keywords: ['security', 'keamanan', 'auth', 'vulnerab', 'pentest', 'encrypt', 'owasp', 'password', 'token', 'audit', 'secret'],
        sprite: 9
    }
];

/** Seat tiles for desks (the agent sits on the chair). Roster agents take the first seats, hires take the rest. */
export const DESK_SEATS: Array<{ x: number; y: number }> = (() => {
    const seats: Array<{ x: number; y: number }> = [];
    for (const y of [17, 22, 27, 32]) {
        for (const x of [4, 9, 14, 19]) seats.push({ x, y });
    }
    return seats;
})();

export function activeRoster(filter = process.env.ACTIVE_AGENTS): AgentProfile[] {
    const ids = (filter || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (ids.length === 0) return ROSTER;
    const selected = ROSTER.filter(p => ids.includes(p.id) || ids.includes(p.name.toLowerCase()));
    return selected.length > 0 ? selected : ROSTER;
}

/**
 * Picks the best agent for a task title: most keyword hits first, then the least loaded agent.
 * `load` is the number of open tasks per agent id.
 */
export function pickAssignee(
    title: string,
    candidates: Array<{ id: string; keywords: string[] }>,
    load: Record<string, number>
): string | null {
    if (candidates.length === 0) return null;
    const text = title.toLowerCase();
    // Short keywords ("ml", "qa", "ci") must match whole words so "html" doesn't count as "ml".
    const matches = (k: string) => k.length <= 3
        ? new RegExp(`(^|[^a-z])${escapeRegExp(k)}([^a-z]|$)`).test(text)
        : text.includes(k);
    const scored = candidates.map(c => ({
        id: c.id,
        score: c.keywords.filter(matches).length,
        load: load[c.id] || 0
    }));
    scored.sort((a, b) => (b.score - a.score) || (a.load - b.load));
    return scored[0].id;
}

/**
 * Finds which agents a chat message is addressed to: "@name", a name/first word match,
 * or "@all"/"semua"/"team" for everyone. Returns [] when nobody is named.
 */
export function resolveMentions(text: string, agents: Array<{ id: string; name: string }>): string[] {
    const lower = text.toLowerCase();
    if (/@(all|semua|team|tim)\b/.test(lower)) return agents.map(a => a.id);
    const hits = agents.filter(a =>
        new RegExp(`(^|[^a-z])@?${escapeRegExp(a.name.toLowerCase())}([^a-z]|$)`).test(lower)
    );
    return hits.map(a => a.id);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
