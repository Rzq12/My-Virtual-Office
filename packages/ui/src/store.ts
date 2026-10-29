import { useSyncExternalStore } from 'react';

/**
 * Shared client state fed by the Colyseus room (see game/Game.ts).
 * Keeping it outside React means nothing is lost when a message arrives before a panel mounts.
 */
export interface AgentInfo {
    id: string;
    name: string;
    role: string;
    action: string;
    currentTask: string;
    thought: string;
    mood: number;
    reputation: number;
    riskLevel: number;
    momentum: number;
    sprite: number;
    provider: string;
    model: string;
}

/** An LLM provider the server can use, with model suggestions (sent by the server as llm-options). */
export interface ProviderOption {
    id: string;
    label: string;
    available: boolean;
    hint?: string;
    defaultModel: string;
    models: string[];
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskInfo {
    id: number;
    title: string;
    agentId: string;
    status: TaskStatus;
    summary?: string;
}

export interface ChatMessage {
    sender: string;
    text: string;
    time?: string;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'error';

export interface OfficeSnapshot {
    connection: ConnectionStatus;
    endpoint: string;
    engine: string;
    agents: AgentInfo[];
    tasks: TaskInfo[];
    chat: ChatMessage[];
    focusedId: string | null;
    providers: ProviderOption[];
}

const MAX_CHAT = 200;

let snapshot: OfficeSnapshot = {
    connection: 'connecting',
    endpoint: '',
    engine: '',
    agents: [],
    tasks: [],
    chat: [],
    focusedId: null,
    providers: []
};

const listeners = new Set<() => void>();

function set(patch: Partial<OfficeSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(listener => listener());
}

export function getSnapshot(): OfficeSnapshot {
    return snapshot;
}

export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useOffice<T>(select: (s: OfficeSnapshot) => T): T {
    return useSyncExternalStore(subscribe, () => select(snapshot));
}

export const officeStore = {
    setConnection(connection: ConnectionStatus, endpoint = snapshot.endpoint) {
        set({ connection, endpoint });
    },
    setEngine(engine: string) {
        if (engine !== snapshot.engine) set({ engine });
    },
    upsertAgent(agent: AgentInfo) {
        const index = snapshot.agents.findIndex(a => a.id === agent.id);
        if (index >= 0 && sameAgent(snapshot.agents[index], agent)) return;
        const agents = index >= 0
            ? snapshot.agents.map((a, i) => (i === index ? agent : a))
            : [...snapshot.agents, agent];
        set({ agents });
    },
    removeAgent(id: string) {
        set({
            agents: snapshot.agents.filter(a => a.id !== id),
            focusedId: snapshot.focusedId === id ? null : snapshot.focusedId
        });
    },
    setTasks(tasks: TaskInfo[]) {
        set({ tasks });
    },
    upsertTask(task: TaskInfo) {
        set({ tasks: mergeTask(snapshot.tasks, task) });
    },
    setChat(chat: ChatMessage[]) {
        set({ chat: chat.slice(-MAX_CHAT) });
    },
    addChat(message: ChatMessage) {
        set({ chat: [...snapshot.chat, message].slice(-MAX_CHAT) });
    },
    setProviders(providers: ProviderOption[]) {
        set({ providers });
    },
    setFocused(focusedId: string | null) {
        if (focusedId !== snapshot.focusedId) set({ focusedId });
    }
};

function sameAgent(a: AgentInfo, b: AgentInfo): boolean {
    return a.name === b.name && a.role === b.role && a.action === b.action && a.currentTask === b.currentTask &&
        a.thought === b.thought && a.sprite === b.sprite && a.provider === b.provider && a.model === b.model &&
        Math.abs(a.mood - b.mood) < 0.005 && Math.abs(a.reputation - b.reputation) < 0.005 &&
        Math.abs(a.riskLevel - b.riskLevel) < 0.005 && Math.abs(a.momentum - b.momentum) < 0.005;
}

/** Inserts or updates a task by id; newest first. */
export function mergeTask(tasks: TaskInfo[], task: TaskInfo): TaskInfo[] {
    const exists = tasks.some(t => t.id === task.id);
    return exists
        ? tasks.map(t => (t.id === task.id ? { ...t, ...task } : t))
        : [task, ...tasks];
}

/** Maps the server's task rows (tasks-sync) to TaskInfo. */
export function tasksFromRows(rows: unknown): TaskInfo[] {
    if (!Array.isArray(rows)) return [];
    return rows.map((row: any) => ({
        id: Number(row.id),
        title: String(row.title || ''),
        agentId: String(row.assigned_to || ''),
        status: (['pending', 'in_progress', 'completed'].includes(row.status) ? row.status : 'pending') as TaskStatus
    }));
}

const AGENT_COLORS = ['#7bed9f', '#70a1ff', '#ff6b81', '#eccc68', '#a29bfe', '#ff9f43', '#1dd1a1', '#48dbfb', '#f368e0', '#c8d6e5', '#fd79a8', '#55efc4', '#fab1a0', '#81ecec', '#ffeaa7', '#dfe6e9'];

/** Stable per-agent accent color used in chat, logs and the team list. */
export function agentColor(idOrName: string): string {
    let hash = 0;
    for (const ch of idOrName.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return AGENT_COLORS[hash % AGENT_COLORS.length];
}
