import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { parseDecisionJson } from '@agent-office/core';
import type { WorkPhase } from '../behavior';

/**
 * How an agent works through one task, as a LangGraph state machine:
 *
 *   plan ─┬─> research ─┬─> execute ─> review ─┬─> finalize
 *         └─────────────┘      ^               │
 *                              └──── revise ───┘   (until the reviewer approves or maxRevisions)
 *
 * Every node calls the agent's own brain (Claude CLI, Codex CLI or an OpenAI-compatible API) through
 * the callbacks in TaskWorkflowDeps, so no LangChain model wrappers are needed. The review is done
 * by a teammate with their own brain.
 */

export const MAX_REVISIONS = 1;
const MAX_DELIVERABLE = 4000;

export interface Person {
    name: string;
    role: string;
    focus?: string;
}

export interface TaskWorkflowDeps {
    author: Person;
    reviewer: Person | null;
    /** LLM call with the author's brain. */
    askAuthor(prompt: string): Promise<string>;
    /** LLM call with the reviewer's brain. */
    askReviewer(prompt: string): Promise<string>;
    search(query: string): Promise<string>;
    /** Called when a node starts (and with its result), so the office can show it. */
    onPhase(phase: WorkPhase, detail: string): void;
    onPlan?(steps: string[]): void;
    onReview?(approved: boolean, feedback: string): void;
    maxRevisions?: number;
}

export interface TaskOutcome {
    summary: string;
    deliverable: string;
    approved: boolean;
    revisions: number;
    plan: string[];
}

const TaskState = Annotation.Root({
    task: Annotation<string>(),
    // Not "plan"/"research": LangGraph forbids a state key with the same name as a node.
    steps: Annotation<string[]>(),
    searchQuery: Annotation<string>(),
    findings: Annotation<string>(),
    deliverable: Annotation<string>(),
    summary: Annotation<string>(),
    feedback: Annotation<string>(),
    approved: Annotation<boolean>(),
    revisions: Annotation<number>()
});

type State = typeof TaskState.State;

function short(text: string, max: number): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function whoIs(p: Person): string {
    return `${p.name}, the ${p.role}${p.focus ? ` (you own ${p.focus})` : ''}`;
}

/** Splits "SUMMARY: ...\n<body>" into its parts; the summary falls back to the first line. */
export function splitSummary(text: string): { summary: string; body: string } {
    const trimmed = text.trim();
    // Accepts "SUMMARY: x", "**Summary:** x" and "**Summary**: x".
    const match = trimmed.match(/^\s*\**\s*summary\s*\**\s*:\s*\**\s*(.+)$/im);
    if (match) {
        const body = trimmed.replace(match[0], '').trim();
        return { summary: short(match[1], 300), body: body || trimmed };
    }
    return { summary: short(trimmed.split('\n')[0] || 'Done.', 300), body: trimmed };
}

export function buildTaskGraph(deps: TaskWorkflowDeps) {
    const maxRevisions = deps.maxRevisions ?? MAX_REVISIONS;

    const plan = async (state: State) => {
        deps.onPhase('plan', `Planning "${short(state.task, 60)}"`);
        const reply = await deps.askAuthor(`You are ${whoIs(deps.author)}. Plan how to do this task:
"${state.task}"

Reply ONLY with JSON: {"steps": ["2 to 4 short steps"], "search": "a web search query if outside facts would help, else empty"}`);
        const parsed = parseDecisionJson(reply) || {};
        const steps: string[] = Array.isArray(parsed.steps)
            ? parsed.steps.map((s: unknown) => short(String(s), 120)).filter(Boolean).slice(0, 4)
            : [];
        const searchQuery = typeof parsed.search === 'string' ? short(parsed.search, 120) : '';
        const result = steps.length > 0 ? steps : [short(state.task, 120)];
        deps.onPhase('plan', `Plan: ${result.map((s, i) => `${i + 1}) ${s}`).join(' ')}`);
        deps.onPlan?.(result);
        return { steps: result, searchQuery };
    };

    const research = async (state: State) => {
        deps.onPhase('research', `Researching "${state.searchQuery}"`);
        const found = await deps.search(state.searchQuery);
        return { findings: short(found, 1500) };
    };

    const execute = async (state: State) => {
        const revising = Boolean(state.feedback);
        deps.onPhase('execute', revising ? `Revising after feedback: ${short(state.feedback, 80)}` : 'Writing the deliverable');
        const reply = await deps.askAuthor(`You are ${whoIs(deps.author)}. Do this task now: "${state.task}"
Plan:
${state.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
${state.findings ? `\nResearch notes:\n${state.findings}\n` : ''}${revising ? `\nYour previous draft:\n${short(state.deliverable, 1500)}\n\nReviewer feedback to address:\n${state.feedback}\n` : ''}
Write the actual result (a spec, code, plan, analysis, ...) in Markdown, under 400 words, in the same language as the task.
The FIRST line must be "SUMMARY: <one sentence describing the result>".`);
        const { summary, body } = splitSummary(reply);
        return {
            deliverable: body.slice(0, MAX_DELIVERABLE),
            summary,
            revisions: (state.revisions || 0) + (revising ? 1 : 0),
            feedback: ''
        };
    };

    const review = async (state: State) => {
        const reviewer = deps.reviewer!;
        deps.onPhase('review', `Asking ${reviewer.name} for a review`);
        const reply = await deps.askReviewer(`You are ${whoIs(reviewer)}. ${deps.author.name} (${deps.author.role}) asks you to review their work on: "${state.task}"

${short(state.deliverable, 2500)}

Approve unless something important is wrong or missing. Reply ONLY with JSON: {"approved": true or false, "feedback": "one or two sentences"}`);
        const parsed = parseDecisionJson(reply) || {};
        // An unreadable review should not block the task.
        const approved = parsed.approved !== false && parsed.approved !== 'false';
        const feedback = typeof parsed.feedback === 'string' ? short(parsed.feedback, 300) : '';
        deps.onPhase('review', `${reviewer.name}: ${approved ? '✅ approved' : '✏️ changes requested'}${feedback ? ` — ${feedback}` : ''}`);
        deps.onReview?.(approved, feedback);
        return { approved, feedback: approved ? '' : feedback || 'Please improve the result.' };
    };

    const finalize = async (state: State) => {
        deps.onPhase('finalize', `Wrapping up: ${short(state.summary, 80)}`);
        return {};
    };

    return new StateGraph(TaskState)
        .addNode('plan', plan)
        .addNode('research', research)
        .addNode('execute', execute)
        .addNode('review', review)
        .addNode('finalize', finalize)
        .addEdge(START, 'plan')
        .addConditionalEdges('plan', (s: State) => (s.searchQuery ? 'research' : 'execute'), ['research', 'execute'])
        .addEdge('research', 'execute')
        .addConditionalEdges('execute', () => (deps.reviewer ? 'review' : 'finalize'), ['review', 'finalize'])
        .addConditionalEdges('review', (s: State) => (s.approved || (s.revisions || 0) >= maxRevisions ? 'finalize' : 'execute'), ['execute', 'finalize'])
        .addEdge('finalize', END)
        .compile();
}

export async function runTaskWorkflow(task: string, deps: TaskWorkflowDeps): Promise<TaskOutcome> {
    const graph = buildTaskGraph(deps);
    const final = await graph.invoke({ task, revisions: 0, approved: false, feedback: '', findings: '', searchQuery: '' });
    return {
        summary: final.summary || 'Done.',
        deliverable: final.deliverable || '',
        approved: Boolean(final.approved) || !deps.reviewer,
        revisions: final.revisions || 0,
        plan: final.steps || []
    };
}
