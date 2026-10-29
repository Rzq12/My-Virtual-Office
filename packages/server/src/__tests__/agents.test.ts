import { ROSTER, DESK_SEATS, activeRoster, pickAssignee, resolveMentions, isSimilarTitle } from '../agents';

describe('isSimilarTitle', () => {
    it('catches re-filed versions of the same request', () => {
        expect(isSimilarTitle(
            'Provide read access to latest feature dataset for ML evaluation baseline validation (see notes/citra.md, Task #31 requirements)',
            'Provide feature dataset access for ML evaluation baseline validation (Task #31) per data requirements in notes/citra.md'
        )).toBe(true);
        expect(isSimilarTitle('Triage server outage in packages/server (infra/DevOps investigation)', 'Triage server outage in packages/server: find cause, restore service')).toBe(true);
    });

    it('keeps genuinely different tasks', () => {
        expect(isSimilarTitle('Setup CI/CD pipeline dengan Docker untuk server', 'Audit CI/CD pipeline and container configs for reliability gaps')).toBe(false);
        expect(isSimilarTitle('Write QA test plan for POST endpoint', 'Draft accessibility checklist for POST endpoint form')).toBe(false);
    });
});

describe('roster', () => {
    it('includes the core engineering roles', () => {
        const roles = ROSTER.map(p => p.role);
        for (const role of ['Software Engineer', 'ML Engineer', 'DevOps Engineer', 'Fullstack Developer', 'Tech Architect']) {
            expect(roles).toContain(role);
        }
    });

    it('has unique ids and names and enough desks for every agent', () => {
        expect(new Set(ROSTER.map(p => p.id)).size).toBe(ROSTER.length);
        expect(new Set(ROSTER.map(p => p.name.toLowerCase())).size).toBe(ROSTER.length);
        expect(DESK_SEATS.length).toBeGreaterThanOrEqual(ROSTER.length);
        expect(new Set(DESK_SEATS.map(s => `${s.x},${s.y}`)).size).toBe(DESK_SEATS.length);
    });

    it('can run a subset via ACTIVE_AGENTS and ignores unknown ids', () => {
        expect(activeRoster('alice, Citra').map(p => p.id)).toEqual(['alice', 'citra']);
        expect(activeRoster('nobody')).toHaveLength(ROSTER.length);
        expect(activeRoster('')).toHaveLength(ROSTER.length);
    });
});

describe('pickAssignee', () => {
    const route = (title: string, load: Record<string, number> = {}) => pickAssignee(title, ROSTER, load);

    it('routes tasks to the matching role', () => {
        expect(route('Set up CI/CD pipeline with Docker')).toBe('dimas');
        expect(route('Train a classification model on the dataset')).toBe('citra');
        expect(route('Write the system design doc for scalability')).toBe('farhan');
        expect(route('Build the React dashboard page')).toBe('eka');
        expect(route('Fix the login API endpoint bug')).toBe('alice');
    });

    it('does not treat "html" as an ML keyword', () => {
        expect(route('Clean up the html footer')).not.toBe('citra');
    });

    it('falls back to the least loaded agent when nothing matches', () => {
        const load = Object.fromEntries(ROSTER.map(p => [p.id, 2]));
        load.gita = 0;
        expect(route('zzz', load)).toBe('gita');
    });

    it('returns null without candidates', () => {
        expect(pickAssignee('anything', [], {})).toBeNull();
    });
});

describe('resolveMentions', () => {
    const agents = ROSTER.map(p => ({ id: p.id, name: p.name }));

    it('finds @mentions and plain names, case-insensitively', () => {
        expect(resolveMentions('@Citra tolong cek model', agents)).toEqual(['citra']);
        expect(resolveMentions('halo dimas dan Eka', agents).sort()).toEqual(['dimas', 'eka']);
    });

    it('does not match names inside other words', () => {
        expect(resolveMentions('bobot model', agents)).toEqual([]);
    });

    it('addresses everyone with @all or @semua', () => {
        expect(resolveMentions('@all standup sekarang', agents)).toHaveLength(agents.length);
        expect(resolveMentions('@semua kumpul', agents)).toHaveLength(agents.length);
    });
});
