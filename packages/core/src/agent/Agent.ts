import { AgentConfig } from './AgentConfig';
import { InferenceAdapter } from './InferenceAdapter';

export type AgentStateStatus = 'IDLE' | 'PERCEIVING' | 'THINKING' | 'ACTING' | 'COMMUNICATING';

export interface Perception {
    time: string;
    location: string;
    nearbyAgents: { name: string; role: string; distance: number }[];
    currentTask: any | null;
    recentMessages: ConversationMessage[];
    memories: string[];
}

export interface Decision {
    thought: string;
    action: 'move' | 'talk' | 'work' | 'use_tool' | 'idle';
    target?: string;
    message?: string;
    toolCall?: { name: string; params: any };
}

export interface ActionResult {
    success: boolean;
    result?: any;
    error?: string;
}

export interface Event {
    type: string;
    data: any;
    timestamp: Date;
}

export interface Message {
    from: string;
    content: string;
}

export interface ConversationMessage {
    from: string;
    to: string;
    content: string;
    timestamp: string;
}

export interface MemoryEntry {
    content: string;
    type: 'thought' | 'conversation' | 'task_result' | 'observation' | 'achievement' | 'relationship';
    timestamp: string;
    importance: number; // 0-1
}

/** Fixes backslashes that are not valid JSON escapes (common when models write code or Windows paths). */
function repairEscapes(json: string): string {
    return json.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
}

/** Top-level {...} blocks in the text, skipping braces inside strings. */
function balancedObjects(text: string): string[] {
    const found: string[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (ch === '}' && depth > 0) {
            depth--;
            if (depth === 0 && start >= 0) found.push(text.slice(start, i + 1));
        }
    }
    return found;
}

/**
 * Pulls the decision object out of a model reply. Models wrap JSON in prose or code fences,
 * emit invalid escapes, or break quoting inside long messages, so this tries progressively
 * looser strategies and finally recovers the plain string fields with regexes.
 */
export function parseDecisionJson(text: string): Record<string, any> | null {
    const greedy = text.match(/\{[\s\S]*\}/)?.[0];
    const candidates = [...balancedObjects(text), ...(greedy ? [greedy] : [])];
    let fallback: Record<string, any> | null = null;
    for (const candidate of candidates) {
        for (const variant of [candidate, repairEscapes(candidate)]) {
            try {
                const value = JSON.parse(variant);
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    if ('action' in value) return value;
                    fallback = fallback || value;
                }
            } catch {
                // try the next variant
            }
        }
    }
    if (fallback) return fallback;

    const field = (name: string) => {
        const m = text.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
        if (!m) return undefined;
        try {
            return JSON.parse(`"${repairEscapes(m[1])}"`) as string;
        } catch {
            return m[1];
        }
    };
    const action = field('action');
    if (!action) return null;
    return { action, thought: field('thought'), target: field('target'), message: field('message') };
}

export class Agent {
    public config: AgentConfig;
    private status: AgentStateStatus = 'IDLE';
    private adapter?: InferenceAdapter;

    // Conversation inbox
    public inbox: ConversationMessage[] = [];

    // Short-term memory buffer
    public memories: MemoryEntry[] = [];

    // Current assigned task
    public currentTask: string = '';

    constructor(config: AgentConfig) {
        this.config = config;
    }

    setInferenceAdapter(adapter: InferenceAdapter) {
        this.adapter = adapter;
    }

    async initialize(): Promise<void> {
        this.status = 'IDLE';
    }

    // --- Conversation System ---

    receiveMessage(msg: ConversationMessage) {
        this.inbox.push(msg);
        // Keep inbox at manageable size
        if (this.inbox.length > 20) this.inbox.shift();
    }

    getUnreadMessages(): ConversationMessage[] {
        return [...this.inbox];
    }

    clearInbox() {
        this.inbox = [];
    }

    // --- Memory System ---

    addMemory(entry: MemoryEntry) {
        this.memories.push(entry);
        // Trim the least important (oldest first on ties) memory, keeping chronological order
        // so getRecentMemories() keeps returning the newest entries.
        const limit = this.config.memory.shortTermLimit || 50;
        while (this.memories.length > limit) {
            let dropIndex = 0;
            for (let i = 1; i < this.memories.length - 1; i++) {
                if (this.memories[i].importance < this.memories[dropIndex].importance) dropIndex = i;
            }
            this.memories.splice(dropIndex, 1);
        }
    }

    getRecentMemories(count: number = 10): string[] {
        return this.memories.slice(-count).map(m => `[${m.type}] ${m.content}`);
    }

    loadMemories(entries: MemoryEntry[]) {
        this.memories = entries;
    }

    // --- Core Think Cycle ---

    async think(perception: Perception): Promise<Decision> {
        this.status = 'THINKING';

        if (!this.adapter) {
            console.warn(`[Agent ${this.config.name}] No InferenceAdapter set, mocking thought...`);
            return { thought: "Waiting for inference adapter...", action: "idle" };
        }

        try {
            // Build rich context
            const teamStr = perception.nearbyAgents.length > 0
                ? `Your team: ${perception.nearbyAgents.map(a => `${a.name} (${a.role})`).join(', ')}`
                : 'You are alone in the office.';

            const messageStr = perception.recentMessages.length > 0
                ? `New messages for you:\n${perception.recentMessages.map(m => `  ${m.from}: "${m.content}"`).join('\n')}`
                : 'No new messages.';

            const memoryStr = perception.memories.length > 0
                ? `Your recent memories (oldest first):\n${perception.memories.slice(-8).join('\n')}`
                : '';

            const taskStr = perception.currentTask
                ? `Your assigned task: ${JSON.stringify(perception.currentTask)}`
                : 'No task assigned yet.';

            const toolStr = this.config.capabilities.length > 0
                ? `Tools you can call with action "use_tool":\n${this.config.capabilities.map(c => `- ${c.name}: ${c.description}`).join('\n')}`
                : 'You have no tools.';

            const prompt = `You are ${this.config.name}, a ${this.config.role} in a virtual office.
Personality: ${this.config.personality.communicationStyle} style. Traits: ${JSON.stringify(this.config.personality.traits)}.
System: ${this.config.inference.systemPrompt}
Current Time: ${perception.time}
Location: ${perception.location}
${teamStr}
${taskStr}
${messageStr}
${memoryStr}

${toolStr}

You must decide your next action. Reply ONLY with a JSON object:
{
  "thought": "your brief inner monologue (max 30 words)",
  "action": "work" | "talk" | "idle" | "use_tool",
  "target": "agent name (or \\"User\\") if talking",
  "message": "what you say if action is talk",
  "toolCall": { "name": "tool_name", "params": {} }
}

Rules:
- Messages from "User" come from the human running the office: answer them first with action "talk" and target "User", in the same language they used.
- Answer a teammate's new message with "talk" only when you have something new to say; never repeat a status update or check-in you already gave (see your memories).
- If you have a task, make real progress on it ("work" or a tool). When it is done, call the complete_task tool with a short summary of the result.
- If you have no task, help a teammate, plan, or create a task — do not just idle.
- Keep thoughts SHORT (under 30 words). Be collaborative.`;

            const res = await this.adapter.complete({
                model: this.config.inference.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.7
            });

            const parsed = parseDecisionJson(res.content);

            if (parsed) {
                const decision: Decision = {
                    thought: (parsed.thought || "Thinking...").slice(0, 120),
                    action: parsed.action || "idle",
                    target: parsed.target,
                    message: parsed.message,
                    toolCall: parsed.toolCall
                };

                // Auto-remember this thought
                this.addMemory({
                    content: decision.thought,
                    type: 'thought',
                    timestamp: perception.time,
                    importance: 0.3
                });

                return decision;
            }
        } catch (e) {
            console.error(`[Agent ${this.config.name}] Inference failed:`, e);
        }

        return { thought: "Systems recovering...", action: "idle" };
    }

    async act(decision: Decision): Promise<ActionResult> {
        this.status = 'ACTING';
        return { success: true };
    }

    async remember(event: Event): Promise<void> {
        this.addMemory({
            content: `${event.type}: ${JSON.stringify(event.data)}`,
            type: 'observation',
            timestamp: event.timestamp.toISOString(),
            importance: 0.5
        });
    }

    async communicate(message: Message): Promise<void> {
        this.status = 'COMMUNICATING';
        this.addMemory({
            content: `${message.from} said: "${message.content}"`,
            type: 'conversation',
            timestamp: new Date().toISOString(),
            importance: 0.7
        });
    }
}
