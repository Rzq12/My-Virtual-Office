import { Room, Client } from 'colyseus';
import { OfficeState, AgentState } from '../schema/OfficeState';
import { Agent, Office, OfficeConfig, ConversationMessage, Decision } from '@agent-office/core';
import {
    THINK_COOLDOWN_MS, MAX_CONCURRENT_THINKS, BrainChoice, brainFor, defaultChoice, describeEngine,
    labelFor, providerInfo, refreshOpenAIModels, validateChoice, createEmbedder
} from '../llm';
import { ToolExecutor } from '../tools/ToolExecutor';
import { MemoryStore } from '../memory/MemoryStore';
import { AgentProfile, activeRoster, DESK_SEATS, pickAssignee, resolveMentions, isSimilarTitle, MAX_OPEN_TASKS_PER_AGENT } from '../agents';

interface HighlightEvent {
    type: string;
    title: string;
    body: string;
    agentId?: string | null;
    scenario: string;
    time: string;
}

interface RelationshipEdge {
    a: string;
    b: string;
    score: number;
    status: 'alliance' | 'neutral' | 'rivalry';
    updatedAt: string;
}

interface ChatEntry {
    sender: string;
    text: string;
    time: string;
}

export const SCENARIOS = ['Free Play', 'Startup Crunch', 'Hackathon Night', 'Incident War Room', 'Product Launch'];

export const CHAOS_EVENTS: Record<string, { label: string; moodDelta: number; riskDelta: number; momentumDelta: number }> = {
    server_outage: { label: 'Server Outage', moodDelta: -0.25, riskDelta: 0.35, momentumDelta: 0.1 },
    funding_cut: { label: 'Funding Cut', moodDelta: -0.2, riskDelta: 0.28, momentumDelta: -0.05 },
    surprise_launch: { label: 'Surprise Launch', moodDelta: 0.12, riskDelta: 0.22, momentumDelta: 0.25 },
    client_escalation: { label: 'Client Escalation', moodDelta: -0.1, riskDelta: 0.3, momentumDelta: 0.08 },
    viral_tweet: { label: 'Viral Tweet', moodDelta: 0.25, riskDelta: 0.12, momentumDelta: 0.3 }
};

const LAYOUT_TYPES = ['desk', 'plant', 'bookshelf', 'coffee_machine', 'table', 'chair', 'whiteboard'];
const VALID_ACTIONS = ['work', 'talk', 'idle', 'use_tool'];
const USER_ALIASES = ['user', 'boss', 'manager', 'human', 'you'];
const HIRE_NAMES = ['Kevin', 'Lina', 'Maya', 'Nanda', 'Oscar', 'Putri', 'Rafi', 'Sari'];
const DOOR = { x: 20, y: 2 };

const BASE_CAPABILITIES = [
    { name: 'code_execute', description: 'Run JavaScript in a sandbox without file or process access. Params: { code: string } — return a value to see it.' },
    { name: 'web_search', description: 'Search the web. Params: { query: string }' },
    { name: 'write_note', description: 'Save notes or a deliverable to your notes file in the shared workspace. Params: { content: string }' },
    { name: 'read_file', description: 'Read a teammate\'s notes from the shared workspace, e.g. "notes/alice.md". It only holds notes the team wrote — there is no code repository. Params: { path: string }' },
    { name: 'create_task', description: 'Create a task for yourself or a teammate. Params: { title: string, assignee: teammate name }' },
    { name: 'complete_task', description: 'Mark YOUR current task as done. Params: { summary: string } describing the result.' }
];

const HIRE_CAPABILITY = {
    name: 'hire_agent',
    description: 'Hire a new team member only when the team clearly lacks a skill. Params: { name: string, role: string }'
};

function cleanText(value: unknown, max: number): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export class OfficeRoom extends Room<OfficeState> {
    private static activeRoom: OfficeRoom | null = null;

    maxClients = 100;
    private office!: Office;
    private demoTickCount = 0;
    private coreAgents: Map<string, Agent> = new Map();
    private profiles: Map<string, AgentProfile> = new Map();
    private thinking: Set<string> = new Set();
    private nextThinkAt: Map<string, number> = new Map();
    private currentTaskIds: Map<string, number> = new Map();
    private talkTargets: Map<string, string> = new Map();
    private hireCount = 0;
    private toolExecutor = new ToolExecutor();
    private memoryStore = new MemoryStore(createEmbedder());
    private agentChoices: Map<string, BrainChoice> = new Map();
    private savedChoices: Record<string, { provider: string; model: string }> = {};
    private sessionId = `session_${Date.now()}`;
    private currentScenario = 'Free Play';
    private highlights: HighlightEvent[] = [];
    private chatLog: ChatEntry[] = [];
    private chaosHistory: Array<{ event: string; label: string; time: string }> = [];
    private relationships: Map<string, RelationshipEdge> = new Map();
    private audienceVotes: Record<string, number> = {};
    private currentLayout: any[] = [];

    static getActiveRoom(): OfficeRoom | null {
        return OfficeRoom.activeRoom;
    }

    async onCreate(options: any) {
        OfficeRoom.activeRoom = this;
        this.setState(new OfficeState());

        await this.memoryStore.initialize();
        await refreshOpenAIModels();
        this.savedChoices = await this.memoryStore.loadAgentModels();

        const config: OfficeConfig = {
            name: options.name || 'Startup HQ',
            grid: { width: 40, height: 40, tileSize: 16 },
            rooms: [],
            furniture: [],
            spawnPoints: [{ x: 10, y: 10 }],
            zones: []
        };
        this.office = new Office(config);

        const roster = activeRoster();
        for (let i = 0; i < roster.length && i < DESK_SEATS.length; i++) {
            const seat = DESK_SEATS[i];
            await this.setupAgent(roster[i], seat, seat);
        }
        this.rebuildRelationshipGraph();
        this.updateEngineSummary();
        await this.restoreOpenTasks();

        const savedLayout = await this.memoryStore.loadLayout('default');
        this.currentLayout = Array.isArray(savedLayout) ? savedLayout : [];
        this.say('System', `Office opened with ${this.coreAgents.size} agents. Mention someone with @Name to talk to them.`);

        // ─── MESSAGE HANDLERS ───

        this.onMessage('chat', (client, message) => {
            const text = cleanText(message?.text, 500);
            if (!text) return;
            this.handleUserChat(text);
        });

        this.onMessage('start-scenario', (client, message) => {
            const scenarioName = String(message?.scenario || '');
            if (!SCENARIOS.includes(scenarioName)) return;
            this.currentScenario = scenarioName;
            this.applyScenarioKickoff(scenarioName);
        });

        this.onMessage('trigger-chaos', (client, message) => {
            const eventName = String(message?.event || '');
            if (!CHAOS_EVENTS[eventName]) return;
            this.applyChaosEvent(eventName);
        });

        this.onMessage('assign-task', async (client, message) => {
            const title = cleanText(message?.title, 200);
            if (!title) return;
            const requested = typeof message?.agentId === 'string' ? message.agentId : '';
            const targetId = requested && this.coreAgents.has(requested) ? requested : await this.autoAssignAgent(title);
            if (!targetId) return;
            console.log(`[TaskBoard] Assigning "${title}" to ${targetId}`);
            await this.assignTask(title, targetId, 'User');
        });

        // Pick the LLM for one agent, or for everyone with agentId "*".
        this.onMessage('set-agent-model', async (client, message) => {
            const choice = validateChoice(message);
            if (typeof choice === 'string') {
                client.send('model-error', { agentId: message?.agentId, error: choice });
                return;
            }
            const requested = String(message?.agentId || '');
            const ids = requested === '*' ? Array.from(this.coreAgents.keys()) : [requested];
            const applied = ids.filter(id => this.applyBrain(id, choice));
            if (applied.length === 0) return;
            await Promise.all(applied.map(id => this.memoryStore.saveAgentModel(id, choice.provider, choice.model)));
            this.updateEngineSummary();
            const who = requested === '*' ? 'Everyone' : this.coreAgents.get(applied[0])!.config.name;
            this.say('System', `🧠 ${who} now thinks with ${labelFor(choice)}.`);
        });

        this.onMessage('save-layout', async (client, message) => {
            const layoutName = cleanText(message?.name, 40) || 'default';
            const layout = this.sanitizeLayout(message?.layout);
            await this.memoryStore.saveLayout(layoutName, JSON.stringify(layout));
            this.currentLayout = layout;
            this.broadcast('layout-sync', { name: layoutName, layout: this.currentLayout });
            this.say('System', '✅ Office layout saved!');
        });

        this.setSimulationInterval(() => this.update(), 100);
    }

    // ─── AGENTS ───

    private async setupAgent(profile: AgentProfile, seat: { x: number; y: number }, spawn: { x: number; y: number }, hiredBy?: string) {
        const { id, name, role } = profile;
        this.state.createAgent(id, name);
        const state = this.state.agents.get(id)!;
        state.x = spawn.x;
        state.y = spawn.y;
        state.role = role;
        state.deskX = seat.x;
        state.deskY = seat.y;
        state.sprite = profile.sprite;

        // Use the model chosen for this agent in the UI, if it is still valid; otherwise the .env default.
        const saved = this.savedChoices[id] ? validateChoice(this.savedChoices[id]) : null;
        const choice = saved && typeof saved !== 'string' ? saved : defaultChoice(this.coreAgents.size);
        const brain = brainFor(choice);
        this.agentChoices.set(id, choice);
        state.provider = choice.provider;
        state.model = choice.model;
        const isLead = /product manager|architect/i.test(role);
        const intro = hiredBy
            ? `You just joined the team, hired by ${hiredBy}. Introduce yourself briefly, then get to work.`
            : 'You have been on this team for a while.';
        const coreAgent = new Agent({
            id, name, role, avatar: `char_${profile.sprite}`,
            inference: {
                ...brain.inference,
                systemPrompt: `You are ${name}, the ${role} of a small software team. You own ${profile.focus}. ${intro} Stay in your lane, hand work in other areas to the right teammate, and keep thoughts SHORT.`,
            },
            personality: {
                traits: profile.traits,
                communicationStyle: profile.communicationStyle,
                workHours: { start: '09:00', end: '17:00' },
                breakFrequency: 120
            },
            capabilities: isLead ? [...BASE_CAPABILITIES, HIRE_CAPABILITY] : [...BASE_CAPABILITIES],
            memory: { shortTermLimit: 50 }
        });

        coreAgent.setInferenceAdapter(brain.adapter);
        console.log(`[${name}] ${role} — brain: ${brain.label}`);
        await coreAgent.initialize();

        const previousMemories = await this.memoryStore.loadMemories(id, 20);
        if (previousMemories.length > 0) {
            coreAgent.loadMemories(previousMemories);
        }

        this.coreAgents.set(id, coreAgent);
        this.profiles.set(id, profile);
        // Stagger the first thoughts so a big team does not hit the LLM all at once.
        this.nextThinkAt.set(id, Date.now() + this.coreAgents.size * 1500);
    }

    /** Switches an agent to another provider/model; takes effect on its next thought. */
    private applyBrain(agentId: string, choice: BrainChoice): boolean {
        const agent = this.coreAgents.get(agentId);
        const state = this.state.agents.get(agentId);
        if (!agent || !state) return false;
        const brain = brainFor(choice);
        agent.setInferenceAdapter(brain.adapter);
        agent.config.inference = { ...agent.config.inference, ...brain.inference };
        this.agentChoices.set(agentId, choice);
        state.provider = choice.provider;
        state.model = choice.model;
        console.log(`[${agent.config.name}] brain switched to ${brain.label}`);
        return true;
    }

    private updateEngineSummary() {
        this.state.engine = describeEngine(Array.from(this.agentChoices.values()));
    }

    private agentDirectory() {
        return Array.from(this.coreAgents.entries()).map(([id, a]) => ({ id, name: a.config.name }));
    }

    /** Resolves "Alice", "alice", "@Alice", "Alice (Software Engineer)" to an agent id. */
    private resolveAgentId(nameOrId: unknown): string | null {
        const raw = cleanText(nameOrId, 80).toLowerCase().replace(/^@/, '');
        if (!raw) return null;
        if (this.coreAgents.has(raw)) return raw;
        const first = raw.split(/[\s(,]/)[0];
        for (const [id, agent] of this.coreAgents) {
            const name = agent.config.name.toLowerCase();
            if (name === raw || name === first) return id;
        }
        return null;
    }

    private leadId(): string {
        for (const [id, agent] of this.coreAgents) {
            if (/product manager/i.test(agent.config.role)) return id;
        }
        return this.coreAgents.keys().next().value as string;
    }

    private deliver(targetId: string, from: string, content: string) {
        const target = this.coreAgents.get(targetId);
        if (!target) return;
        const msg: ConversationMessage = {
            from,
            to: target.config.name,
            content,
            timestamp: this.state.officeTime
        };
        target.receiveMessage(msg);
    }

    private handleUserChat(text: string) {
        this.say('User', text);
        let targets = resolveMentions(text, this.agentDirectory());
        if (targets.length === 0) targets = [this.leadId()];
        for (const id of targets) {
            this.deliver(id, 'User', text);
            // The human is waiting: let the agent answer on the next free slot.
            this.nextThinkAt.set(id, 0);
        }
    }

    // ─── SIMULATION LOOP ───

    update() {
        this.state.officeTime = new Date().toISOString();
        this.scheduleThinking();

        this.demoTickCount++;
        if (this.demoTickCount >= 5) {
            this.demoTickCount = 0;
            this.moveAgents();
        }
    }

    private scheduleThinking() {
        if (this.thinking.size >= MAX_CONCURRENT_THINKS) return;
        const now = Date.now();
        const ready = Array.from(this.coreAgents.keys())
            .filter(id => !this.thinking.has(id) && now >= (this.nextThinkAt.get(id) || 0))
            // Agents with unread messages (especially from the User) go first.
            .sort((a, b) => this.urgency(b) - this.urgency(a) || (this.nextThinkAt.get(a) || 0) - (this.nextThinkAt.get(b) || 0));

        for (const id of ready) {
            if (this.thinking.size >= MAX_CONCURRENT_THINKS) break;
            void this.runThink(id);
        }
    }

    private urgency(id: string): number {
        const inbox = this.coreAgents.get(id)?.inbox || [];
        if (inbox.some(m => m.from === 'User')) return 2;
        return inbox.length > 0 ? 1 : 0;
    }

    private async runThink(id: string) {
        const coreAgent = this.coreAgents.get(id);
        const agentState = this.state.agents.get(id);
        if (!coreAgent || !agentState) return;
        this.thinking.add(id);

        try {
            const team = Array.from(this.coreAgents.entries())
                .filter(([otherId]) => otherId !== id)
                .map(([otherId, other]) => {
                    const otherState = this.state.agents.get(otherId);
                    const distance = otherState ? Math.abs(agentState.x - otherState.x) + Math.abs(agentState.y - otherState.y) : 99;
                    return { name: other.config.name, role: other.config.role, distance };
                });

            // Take the messages now; anything that arrives while the LLM is busy waits for the next turn.
            const inbox = coreAgent.getUnreadMessages();
            coreAgent.clearInbox();

            const decision = await coreAgent.think({
                time: this.state.officeTime,
                location: `${agentState.x},${agentState.y}`,
                nearbyAgents: team,
                currentTask: coreAgent.currentTask || null,
                recentMessages: inbox,
                memories: coreAgent.getRecentMemories(8)
            });

            for (const m of inbox) {
                coreAgent.addMemory({
                    content: `${m.from} told me: "${m.content.slice(0, 200)}"`,
                    type: 'conversation',
                    timestamp: m.timestamp,
                    importance: m.from === 'User' ? 0.9 : 0.6
                });
            }

            await this.applyDecision(id, coreAgent, agentState, decision);

            if (Math.random() < 0.3) {
                await this.memoryStore.saveMemories(id, coreAgent.memories.slice(-3), this.sessionId);
            }
        } catch (err) {
            console.error(`Agent ${id} think error:`, err);
        } finally {
            this.thinking.delete(id);
            const userWaiting = coreAgent.inbox.some(m => m.from === 'User');
            this.nextThinkAt.set(id, userWaiting ? 0 : Date.now() + THINK_COOLDOWN_MS);
        }
    }

    private async applyDecision(id: string, coreAgent: Agent, agentState: AgentState, decision: Decision) {
        const action = VALID_ACTIONS.includes(decision.action) ? decision.action : 'idle';
        agentState.action = action;
        if (decision.thought) agentState.thought = decision.thought;
        this.updateAgentViralMetrics(id, action);

        const name = coreAgent.config.name;
        const message = cleanText(decision.message, 600);

        if (action === 'talk' && message) {
            const targetRaw = cleanText(decision.target, 80).toLowerCase();
            const targetId = this.resolveAgentId(targetRaw);

            if (targetId && targetId !== id) {
                const targetAgent = this.coreAgents.get(targetId)!;
                this.deliver(targetId, name, message);
                this.talkTargets.set(id, targetId);
                this.say(name, `💬 (to ${targetAgent.config.name}): ${message}`);
                this.emitHighlight('conversation', `${name} pinged ${targetAgent.config.name}`, message.slice(0, 120), id);
                this.updateRelationship(id, targetId, 0.08);
                this.rememberSaid(id, coreAgent, targetAgent.config.name, message);
            } else {
                const toUser = USER_ALIASES.includes(targetRaw.replace(/^@/, '')) || !targetRaw;
                const audience = toUser ? 'User' : 'team';
                this.talkTargets.delete(id);
                this.say(name, `💬 (to ${audience}): ${message}`);
                this.emitHighlight('conversation', `${name} → ${audience}`, message.slice(0, 120), id);
                this.rememberSaid(id, coreAgent, audience, message);
            }
        } else {
            this.talkTargets.delete(id);
        }

        const tool = decision.toolCall;
        const toolName = typeof tool?.name === 'string' ? tool.name : '';
        if (!toolName || (action !== 'use_tool' && toolName !== 'complete_task')) return;
        const params = tool?.params && typeof tool.params === 'object' ? tool.params : {};

        if (toolName === 'create_task') {
            const title = cleanText(params.title, 200);
            if (!title) return;
            const targetId = this.resolveAgentId(params.assignee) || await this.autoAssignAgent(title);
            if (targetId) await this.assignTask(title, targetId, name);
        } else if (toolName === 'complete_task') {
            await this.completeCurrentTask(id, cleanText(params.summary, 600) || 'Done.');
        } else if (toolName === 'hire_agent') {
            await this.hireAgent(coreAgent, cleanText(params.name, 30), cleanText(params.role, 40));
        } else {
            const result = await this.toolExecutor.execute(toolName, params, { agentName: name });
            const summary = result.success ? (result.output || '(no output)') : (result.error || 'Tool failed');
            this.say(name, `🔧 Used tool [${toolName}]: ${summary.slice(0, 160)}`);
            this.emitHighlight('tool', `${name} used ${toolName}`, summary.slice(0, 120), id);
            coreAgent.addMemory({
                content: `Tool ${toolName} ${result.success ? 'result' : 'failed'}: ${summary.slice(0, 200)}`,
                type: 'task_result',
                timestamp: this.state.officeTime,
                importance: 0.8
            });
        }
    }

    private rememberSaid(id: string, coreAgent: Agent, to: string, message: string) {
        const entry = {
            content: `I told ${to}: "${message.slice(0, 200)}"`,
            type: 'conversation' as const,
            timestamp: this.state.officeTime,
            importance: 0.6
        };
        coreAgent.addMemory(entry);
        void this.memoryStore.saveMemory(id, entry, this.sessionId);
    }

    private async hireAgent(hiringAgent: Agent, requestedName: string, requestedRole: string) {
        const seat = DESK_SEATS[this.coreAgents.size];
        if (!seat) {
            this.say('🏢 Office', `⚠️ ${hiringAgent.config.name} tried to hire, but every desk is taken (max ${DESK_SEATS.length} agents).`);
            return;
        }

        const taken = new Set(Array.from(this.coreAgents.values()).map(a => a.config.name.toLowerCase()));
        let hireName = requestedName.replace(/[^\p{L}\p{N} .'-]/gu, '').trim().split(' ')[0] || '';
        if (!hireName || taken.has(hireName.toLowerCase())) {
            hireName = HIRE_NAMES.find(n => !taken.has(n.toLowerCase())) || `Agent${this.hireCount + 1}`;
        }
        const role = requestedRole || 'Software Engineer Intern';
        const id = `hire_${this.hireCount}`;
        this.hireCount++;

        const profile: AgentProfile = {
            id,
            name: hireName,
            role,
            focus: `work that fits a ${role}`,
            communicationStyle: /design/i.test(role) ? 'creative' : 'casual',
            traits: { openness: 0.9, conscientiousness: 0.7, extraversion: 0.8, agreeableness: 0.9, neuroticism: 0.2 },
            keywords: role.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2),
            sprite: this.coreAgents.size
        };
        await this.setupAgent(profile, seat, DOOR, hiringAgent.config.name);
        this.nextThinkAt.set(id, Date.now() + 3000);
        this.rebuildRelationshipGraph();
        this.updateEngineSummary();

        this.say('🏢 Office', `🎉 ${hiringAgent.config.name} hired ${hireName} as ${role}! Welcome to the team!`);
        this.emitHighlight('hiring', `${hireName} joined the team`, `${hiringAgent.config.name} hired ${hireName} (${role}).`, id);
        hiringAgent.addMemory({
            content: `I hired ${hireName} as a ${role}. They just joined the team.`,
            type: 'achievement',
            timestamp: this.state.officeTime,
            importance: 0.9
        });
    }

    // ─── TASKS ───

    private async openTaskLoad(): Promise<Record<string, number>> {
        const load: Record<string, number> = {};
        for (const t of await this.memoryStore.getOpenTasks()) {
            if (t.assigned_to) load[t.assigned_to] = (load[t.assigned_to] || 0) + 1;
        }
        return load;
    }

    private async autoAssignAgent(title: string): Promise<string | null> {
        const candidates = Array.from(this.profiles.values());
        return pickAssignee(title, candidates, await this.openTaskLoad());
    }

    /** Creates a task; the agent starts it right away or queues it behind the current one. */
    async assignTask(title: string, agentId: string, assignedBy: string) {
        const agent = this.coreAgents.get(agentId);
        if (!agent) return;

        // Agents keep re-filing the same request; drop duplicates and cap how much they pile on a teammate.
        if (assignedBy !== 'User') {
            const open = (await this.memoryStore.getOpenTasks()).filter(t => t.assigned_to === agentId);
            const duplicate = open.find(t => isSimilarTitle(t.title, title));
            const reason = duplicate
                ? `${agent.config.name} already has this as task #${duplicate.id} "${duplicate.title}". Do not file it again; wait or work on something else.`
                : open.length >= MAX_OPEN_TASKS_PER_AGENT
                    ? `${agent.config.name} already has ${open.length} open tasks. Do not add more; help them or work on your own task.`
                    : '';
            if (reason) {
                const creatorId = this.resolveAgentId(assignedBy);
                this.coreAgents.get(creatorId || '')?.addMemory({
                    content: `My new task "${title}" was not created: ${reason}`,
                    type: 'observation',
                    timestamp: this.state.officeTime,
                    importance: 0.8
                });
                return;
            }
        }

        const busy = this.currentTaskIds.has(agentId);
        const taskId = await this.memoryStore.createTask(title, agentId);

        if (busy) {
            this.say('System', `📋 "${title}" queued for ${agent.config.name} (busy with "${agent.currentTask}")`);
            this.broadcastTask(taskId, title, agentId, 'pending');
            return;
        }
        await this.startTask(agentId, taskId, title);
        const by = assignedBy === agent.config.name ? '' : assignedBy !== 'User' ? ` by ${assignedBy}` : '';
        this.say('System', by || assignedBy === 'User'
            ? `📋 Task "${title}" assigned to ${agent.config.name}${by}`
            : `📋 ${agent.config.name} picked up "${title}"`);
        if (assignedBy !== 'User' && assignedBy !== agent.config.name) {
            this.emitHighlight('task', `${assignedBy} assigned work`, `"${title}" is now owned by ${agent.config.name}.`, agentId);
        }
    }

    private async startTask(agentId: string, taskId: number, title: string) {
        const agent = this.coreAgents.get(agentId);
        const state = this.state.agents.get(agentId);
        if (!agent || !state) return;
        this.currentTaskIds.set(agentId, taskId);
        agent.currentTask = title;
        state.currentTask = title;
        state.action = 'work';
        await this.memoryStore.updateTaskStatus(taskId, 'in_progress');
        agent.addMemory({
            content: `I started task #${taskId}: "${title}"`,
            type: 'observation',
            timestamp: this.state.officeTime,
            importance: 0.8
        });
        this.broadcastTask(taskId, title, agentId, 'in_progress');
        this.nextThinkAt.set(agentId, Math.min(this.nextThinkAt.get(agentId) || 0, Date.now() + 2000));
    }

    async completeCurrentTask(agentId: string, summary: string) {
        const agent = this.coreAgents.get(agentId);
        const state = this.state.agents.get(agentId);
        const taskId = this.currentTaskIds.get(agentId);
        if (!agent || !state) return;
        if (taskId === undefined) {
            agent.addMemory({
                content: 'I tried to complete a task, but I have no task assigned.',
                type: 'observation',
                timestamp: this.state.officeTime,
                importance: 0.5
            });
            return;
        }

        const title = agent.currentTask;
        await this.memoryStore.completeTask(taskId);
        this.currentTaskIds.delete(agentId);
        agent.currentTask = '';
        state.currentTask = '';
        state.reputation = this.clamp01(state.reputation + 0.1);
        state.mood = this.clamp01(state.mood + 0.05);

        await this.toolExecutor.writeNote(`Completed task #${taskId} "${title}"\n\n${summary}`, agent.config.name);
        agent.addMemory({
            content: `I completed task #${taskId} "${title}": ${summary.slice(0, 200)}`,
            type: 'achievement',
            timestamp: this.state.officeTime,
            importance: 0.9
        });
        this.broadcastTask(taskId, title, agentId, 'completed', summary);
        this.say(agent.config.name, `✅ Finished "${title}": ${summary}`);
        this.emitHighlight('task_done', `${agent.config.name} shipped a task`, `"${title}" — ${summary.slice(0, 100)}`, agentId);

        const next = (await this.memoryStore.getOpenTasks()).find(t => t.assigned_to === agentId);
        if (next) await this.startTask(agentId, next.id, next.title);
    }

    private broadcastTask(id: number, title: string, agentId: string, status: string, summary?: string) {
        this.broadcast('task-update', {
            id,
            title,
            agentId,
            agentName: this.coreAgents.get(agentId)?.config.name || agentId,
            status,
            summary
        });
    }

    /** After a restart, give each agent back the work it had not finished. */
    private async restoreOpenTasks() {
        for (const task of await this.memoryStore.getOpenTasks()) {
            const agentId = task.assigned_to || '';
            if (!this.coreAgents.has(agentId) || this.currentTaskIds.has(agentId)) continue;
            await this.startTask(agentId, task.id, task.title);
        }
    }

    // ─── MOVEMENT ───

    private moveAgents() {
        const clamp = (agent: AgentState) => {
            agent.x = Math.max(2, Math.min(36, agent.x));
            agent.y = Math.max(2, Math.min(36, agent.y));
        };

        this.state.agents.forEach((agent, key) => {
            let target = { x: agent.deskX, y: agent.deskY };

            // While talking, walk over to stand next to the person being addressed.
            const partner = agent.action === 'talk' ? this.state.agents.get(this.talkTargets.get(key) || '') : undefined;
            if (partner) {
                const dist = Math.abs(agent.x - partner.x) + Math.abs(agent.y - partner.y);
                if (dist <= 1) return;
                target = { x: partner.x + 1, y: partner.y };
            }

            if (agent.x < target.x) agent.x += 1;
            else if (agent.x > target.x) agent.x -= 1;
            else if (agent.y < target.y) agent.y += 1;
            else if (agent.y > target.y) agent.y -= 1;
            clamp(agent);
        });
    }

    // ─── CHAT / HIGHLIGHTS ───

    private say(sender: string, text: string) {
        const entry: ChatEntry = { sender, text, time: this.state.officeTime };
        this.chatLog.push(entry);
        if (this.chatLog.length > 100) this.chatLog.shift();
        this.broadcast('chat', entry);
    }

    private clamp01(value: number): number {
        return Math.max(0, Math.min(1, value));
    }

    private emitHighlight(type: string, title: string, body: string, agentId?: string) {
        const payload: HighlightEvent = {
            type,
            title,
            body,
            agentId: agentId || null,
            scenario: this.currentScenario,
            time: this.state.officeTime
        };
        this.highlights = [payload, ...this.highlights].slice(0, 200);
        this.broadcast('highlight-event', payload);
    }

    /**
     * Nudges telemetry after each decision. Every value drifts back toward a baseline,
     * so it reflects recent behaviour instead of saturating at 0% or 100%.
     */
    private updateAgentViralMetrics(agentId: string, action: string) {
        const state = this.state.agents.get(agentId);
        if (!state) return;
        const jitter = (Math.random() - 0.5) * 0.04;
        const drift = (value: number, base: number) => value + (base - value) * 0.15;

        state.momentum = this.clamp01(drift(state.momentum, 0.4) + (action === 'idle' ? -0.02 : action === 'use_tool' ? 0.08 : 0.05) + jitter);
        state.riskLevel = this.clamp01(drift(state.riskLevel, 0.2) + (action === 'use_tool' ? 0.04 : 0) + jitter / 2);
        state.mood = this.clamp01(drift(state.mood, 0.6) + (action === 'talk' ? 0.05 : 0) + jitter);
        state.reputation = this.clamp01(drift(state.reputation, 0.5) + (action === 'work' || action === 'use_tool' ? 0.04 : 0) + jitter / 2);
    }

    private remindAll(content: string, importance: number) {
        this.coreAgents.forEach(agent => agent.addMemory({
            content,
            type: 'observation',
            timestamp: this.state.officeTime,
            importance
        }));
    }

    private applyScenarioKickoff(scenarioName: string) {
        this.broadcast('scenario-event', {
            type: 'scenario-started',
            scenario: scenarioName,
            time: this.state.officeTime
        });
        this.say('🎬 Producer', `Scenario loaded: ${scenarioName}. Let the office drama begin.`);
        this.emitHighlight('scenario', `Scenario: ${scenarioName}`, `The office switched into ${scenarioName} mode.`);
        this.remindAll(`The office just switched into "${scenarioName}" mode. Act accordingly.`, 0.8);

        this.state.agents.forEach((agent, id) => {
            agent.momentum = this.clamp01(agent.momentum + 0.15);
            agent.riskLevel = this.clamp01(agent.riskLevel + 0.1);
            if (Math.random() < 0.3) {
                this.emitHighlight('character_arc', `${agent.name} steps up`, `${agent.name} is pushing hard as ${scenarioName} starts.`, id);
            }
        });
    }

    private applyChaosEvent(eventName: string) {
        const selected = CHAOS_EVENTS[eventName] || CHAOS_EVENTS.server_outage;
        this.chaosHistory = [
            { event: eventName, label: selected.label, time: this.state.officeTime },
            ...this.chaosHistory
        ].slice(0, 100);
        this.broadcast('scenario-event', {
            type: 'chaos-triggered',
            event: eventName,
            label: selected.label,
            time: this.state.officeTime
        });
        this.say('⚠️ Chaos Engine', `${selected.label} hit the office. Everyone reacts in real-time.`);
        this.emitHighlight('chaos', selected.label, `Chaos event "${selected.label}" changed team mood and risk levels.`);
        this.remindAll(`Breaking: "${selected.label}" just hit the office. React if it touches your area.`, 0.85);

        this.state.agents.forEach((agent, id) => {
            agent.mood = this.clamp01(agent.mood + selected.moodDelta + (Math.random() - 0.5) * 0.08);
            agent.riskLevel = this.clamp01(agent.riskLevel + selected.riskDelta + Math.random() * 0.08);
            agent.momentum = this.clamp01(agent.momentum + selected.momentumDelta + (Math.random() - 0.5) * 0.05);
            if (agent.riskLevel > 0.75) {
                this.emitHighlight('high_risk', `${agent.name} is under pressure`, `${agent.name}'s risk level spiked after ${selected.label}.`, id);
            }
        });

        // Chaos can create alliances or rivalries.
        const ids = Array.from(this.state.agents.keys());
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                this.updateRelationship(ids[i], ids[j], (Math.random() - 0.5) * 0.35, false);
            }
        }
        this.emitRelationshipGraph();
    }

    // ─── RELATIONSHIPS ───

    private relationshipKey(a: string, b: string): string {
        return [a, b].sort().join('::');
    }

    private statusFromScore(score: number): RelationshipEdge['status'] {
        if (score > 0.35) return 'alliance';
        if (score < -0.35) return 'rivalry';
        return 'neutral';
    }

    private rebuildRelationshipGraph() {
        const ids = Array.from(this.state.agents.keys());
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const key = this.relationshipKey(ids[i], ids[j]);
                if (!this.relationships.has(key)) {
                    this.relationships.set(key, {
                        a: ids[i],
                        b: ids[j],
                        score: 0,
                        status: 'neutral',
                        updatedAt: this.state.officeTime
                    });
                }
            }
        }
        this.emitRelationshipGraph();
    }

    private updateRelationship(a: string, b: string, delta: number, emit = true) {
        const key = this.relationshipKey(a, b);
        const existing = this.relationships.get(key) || {
            a: [a, b].sort()[0],
            b: [a, b].sort()[1],
            score: 0,
            status: 'neutral' as const,
            updatedAt: this.state.officeTime
        };
        const score = Math.max(-1, Math.min(1, existing.score + delta));
        this.relationships.set(key, {
            ...existing,
            score,
            status: this.statusFromScore(score),
            updatedAt: this.state.officeTime
        });
        if (emit) this.emitRelationshipGraph();
    }

    private emitRelationshipGraph() {
        this.broadcast('relationship-update', this.buildRelationshipPayload());
    }

    private buildRelationshipPayload() {
        const idToName: Record<string, string> = {};
        this.state.agents.forEach((agent, id) => {
            idToName[id] = agent.name;
        });
        return {
            edges: Array.from(this.relationships.values()).map((edge) => ({
                ...edge,
                aName: idToName[edge.a] || edge.a,
                bName: idToName[edge.b] || edge.b
            })),
            time: this.state.officeTime
        };
    }

    // ─── PUBLIC API (REST) ───

    public registerAudienceVote(eventName: string, voterId?: string) {
        const normalized = String(eventName || '');
        if (!CHAOS_EVENTS[normalized]) {
            return { accepted: false, event: normalized, voterId: voterId || null, tally: 0, triggered: false };
        }
        this.audienceVotes[normalized] = (this.audienceVotes[normalized] || 0) + 1;
        const totalVotes = Object.values(this.audienceVotes).reduce((sum, value) => sum + value, 0);
        const shouldTrigger = this.audienceVotes[normalized] >= 3 || totalVotes % 5 === 0;

        if (shouldTrigger) {
            this.applyChaosEvent(normalized);
            this.emitHighlight('audience_vote', `Audience triggered ${CHAOS_EVENTS[normalized].label}`, `Viewers forced a ${CHAOS_EVENTS[normalized].label} chaos event.`);
            this.audienceVotes[normalized] = 0;
        }

        return {
            accepted: true,
            event: normalized,
            voterId: voterId || null,
            tally: this.audienceVotes[normalized] || 0,
            triggered: shouldTrigger
        };
    }

    public getEpisodeRecap() {
        const topHighlights = [...this.highlights].slice(0, 10);
        const leaderboard = Array.from(this.state.agents.entries()).map(([id, agent]) => {
            const impact = (
                agent.momentum * 0.35 +
                agent.reputation * 0.3 +
                agent.mood * 0.2 +
                (1 - agent.riskLevel) * 0.15
            );
            return {
                id,
                name: agent.name,
                role: agent.role,
                action: agent.action,
                mood: agent.mood,
                reputation: agent.reputation,
                riskLevel: agent.riskLevel,
                momentum: agent.momentum,
                impact: Number(impact.toFixed(3))
            };
        }).sort((a, b) => b.impact - a.impact);

        const avgMomentum = leaderboard.length
            ? leaderboard.reduce((sum, item) => sum + item.momentum, 0) / leaderboard.length
            : 0;
        const avgRisk = leaderboard.length
            ? leaderboard.reduce((sum, item) => sum + item.riskLevel, 0) / leaderboard.length
            : 0;
        const outcome = avgMomentum > 0.65 && avgRisk < 0.5
            ? 'Launch trajectory: team executed under pressure and came out stronger.'
            : avgRisk > 0.65
                ? 'High volatility: chaos dominated this episode.'
                : 'Mixed outcome: strong moments with unresolved tensions.';

        return {
            generatedAt: this.state.officeTime,
            scenario: this.currentScenario,
            topHighlights,
            leaderboard: leaderboard.slice(0, 10),
            outcomeCard: {
                title: `${this.currentScenario} Outcome`,
                summary: outcome,
                chaosEvents: this.chaosHistory.slice(0, 10),
                activeRelationships: Array.from(this.relationships.values()).filter((edge) => edge.status !== 'neutral').length
            }
        };
    }

    private sanitizeLayout(raw: unknown): any[] {
        if (!Array.isArray(raw)) return [];
        return raw.slice(0, 200).flatMap((item: any, index: number) => {
            if (!item || !LAYOUT_TYPES.includes(item.type)) return [];
            const x = Number(item.x);
            const y = Number(item.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
            return [{
                id: cleanText(item.id, 64) || `item_${index}`,
                type: item.type,
                x: Math.max(2, Math.min(36, Math.round(x))),
                y: Math.max(2, Math.min(36, Math.round(y))),
                label: cleanText(item.label, 20) || undefined
            }];
        });
    }

    async onJoin(client: Client) {
        console.log(client.sessionId, 'joined the office room!');
        client.send('llm-options', { providers: providerInfo() });
        client.send('chat-history', this.chatLog);
        client.send('highlight-history', this.highlights.slice(0, 8));
        client.send('relationship-update', this.buildRelationshipPayload());
        client.send('layout-sync', { name: 'default', layout: this.currentLayout });
        client.send('tasks-sync', await this.memoryStore.getTasks());
    }

    onLeave(client: Client) {
        console.log(client.sessionId, 'left the office room!');
    }

    async onDispose() {
        console.log('room', this.roomId, 'disposing... saving memories');
        OfficeRoom.activeRoom = null;
        for (const [id, agent] of this.coreAgents) {
            await this.memoryStore.saveMemories(id, agent.memories, this.sessionId);
        }
        await this.memoryStore.close();
    }
}
