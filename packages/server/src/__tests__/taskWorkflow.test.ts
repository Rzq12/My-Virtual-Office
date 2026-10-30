import { runTaskWorkflow, splitSummary, TaskWorkflowDeps } from '../workflow/taskWorkflow';

function deps(overrides: Partial<TaskWorkflowDeps> = {}) {
    const phases: string[] = [];
    const calls = { author: [] as string[], reviewer: [] as string[], search: [] as string[] };
    const base: TaskWorkflowDeps = {
        author: { name: 'Alice', role: 'Software Engineer' },
        reviewer: { name: 'Gita', role: 'QA Engineer' },
        askAuthor: async prompt => {
            calls.author.push(prompt);
            if (prompt.includes('Plan how')) return '{"steps": ["Design the endpoint", "Write it"], "search": ""}';
            return 'SUMMARY: Added a health endpoint.\n\n```js\napp.get("/health", ...)\n```';
        },
        askReviewer: async prompt => {
            calls.reviewer.push(prompt);
            return '{"approved": true, "feedback": "Looks good."}';
        },
        search: async query => {
            calls.search.push(query);
            return 'Result: use /healthz';
        },
        onPhase: phase => { if (phases[phases.length - 1] !== phase) phases.push(phase); },
        ...overrides
    };
    return { base, phases, calls };
}

describe('task workflow', () => {
    it('plans, executes, gets a review and finishes', async () => {
        const { base, phases, calls } = deps();
        const outcome = await runTaskWorkflow('Add a health endpoint', base);
        expect(phases).toEqual(['plan', 'execute', 'review', 'finalize']);
        expect(outcome).toMatchObject({ summary: 'Added a health endpoint.', approved: true, revisions: 0, plan: ['Design the endpoint', 'Write it'] });
        expect(outcome.deliverable).toContain('app.get("/health"');
        expect(calls.reviewer[0]).toContain('app.get("/health"');
        expect(calls.search).toEqual([]);
    });

    it('researches first when the plan asks for a search', async () => {
        const { base, phases, calls } = deps({
            askAuthor: async prompt => prompt.includes('Plan how')
                ? 'Sure! {"steps": ["Look up conventions"], "search": "health check endpoint conventions"}'
                : 'SUMMARY: Done.\nBody'
        });
        await runTaskWorkflow('Add a health endpoint', base);
        expect(phases).toEqual(['plan', 'research', 'execute', 'review', 'finalize']);
        expect(calls.search).toEqual(['health check endpoint conventions']);
    });

    it('revises after rejected feedback, at most once', async () => {
        const { base, phases, calls } = deps({
            askReviewer: async () => '{"approved": false, "feedback": "Missing tests."}'
        });
        const outcome = await runTaskWorkflow('Add a health endpoint', base);
        expect(phases).toEqual(['plan', 'execute', 'review', 'execute', 'review', 'finalize']);
        expect(outcome).toMatchObject({ approved: false, revisions: 1 });
        expect(calls.author[2]).toContain('Missing tests.');
    });

    it('skips the review when there is nobody to review and survives unparseable replies', async () => {
        const { base, phases } = deps({ reviewer: null, askAuthor: async () => 'no json here' });
        const outcome = await runTaskWorkflow('Write release notes', base);
        expect(phases).toEqual(['plan', 'execute', 'finalize']);
        expect(outcome.plan).toEqual(['Write release notes']);
        expect(outcome.summary).toBe('no json here');
    });

    it('splits the summary line from the deliverable', () => {
        expect(splitSummary('**Summary:** Built it\n\nDetails')).toEqual({ summary: 'Built it', body: 'Details' });
        expect(splitSummary('Just one line')).toEqual({ summary: 'Just one line', body: 'Just one line' });
    });
});
