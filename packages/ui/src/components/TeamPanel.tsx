import React from 'react';
import { Panel } from './Panel';
import { useOffice, officeStore, agentColor } from '../store';

const ACTION_LABELS: Record<string, { icon: string; color: string }> = {
    work: { icon: '💻 work', color: '#74b9ff' },
    talk: { icon: '💬 talk', color: '#a29bfe' },
    use_tool: { icon: '🔧 tool', color: '#fdcb6e' },
    idle: { icon: '😌 idle', color: '#636e72' }
};

// What the body is doing wins over the LLM action when it says more (a break, a workflow phase).
const PHASE_LABELS: Record<string, { icon: string; color: string }> = {
    plan: { icon: '📝 plan', color: '#81ecec' },
    research: { icon: '🔎 research', color: '#fdcb6e' },
    execute: { icon: '⌨️ build', color: '#74b9ff' },
    review: { icon: '🤝 review', color: '#a29bfe' },
    finalize: { icon: '🖨️ wrap up', color: '#55efc4' }
};
const BREAK_LABELS: Record<string, { icon: string; color: string }> = {
    drink: { icon: '☕ coffee', color: '#e17055' },
    snack: { icon: '🍩 snack', color: '#fab1a0' },
    lounge: { icon: '😌 chill', color: '#b2bec3' }
};

function statusBadge(agent: { action: string; activity: string; phase: string }) {
    return BREAK_LABELS[agent.activity] || PHASE_LABELS[agent.phase] || ACTION_LABELS[agent.action] || ACTION_LABELS.idle;
}

function pct(value: number): string {
    return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

/** The team roster plus an inspector for the selected agent. Selecting an agent makes the camera follow them. */
export function TeamPanel() {
    const agents = useOffice(s => s.agents);
    const focusedId = useOffice(s => s.focusedId);
    const focused = agents.find(a => a.id === focusedId);

    return (
        <Panel id="team" title="👥 Team" subtitle={`${agents.length} agents · click to follow`}>
            {agents.length === 0 && <p className="empty">Waiting for the office to open...</p>}
            <div role="list" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {agents.map(agent => {
                    const action = statusBadge(agent);
                    const selected = agent.id === focusedId;
                    return (
                        <div role="listitem" key={agent.id}>
                            <button
                                type="button"
                                className="agent-row"
                                aria-pressed={selected}
                                title={`${agent.name} thinks with ${agent.provider} · ${agent.model || 'default'}`}
                                onClick={() => officeStore.setFocused(selected ? null : agent.id)}
                            >
                                <span className="dot" style={{ background: agentColor(agent.name) }} aria-hidden="true" />
                                <span style={{ minWidth: 0 }}>
                                    <span className="agent-name" style={{ display: 'block' }}>{agent.name}</span>
                                    <span className="agent-role" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {agent.role}{agent.currentTask ? ` · ${agent.currentTask}` : ''}
                                    </span>
                                </span>
                                <span className="badge" style={{ color: action.color }}>{action.icon}</span>
                            </button>
                        </div>
                    );
                })}
            </div>

            {focused && (
                <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: 'rgba(124,108,240,0.1)', border: '1px solid rgba(124,108,240,0.3)', fontSize: 12 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: agentColor(focused.name) }}>{focused.name}</div>
                    <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>{focused.role}</div>
                    <div style={{ marginBottom: 4 }}><strong>Model:</strong> {focused.provider === 'claude' ? 'Claude' : focused.provider === 'chatgpt' ? 'ChatGPT' : 'OpenAI-compatible'} · {focused.model || 'default'}</div>
                    <div style={{ marginBottom: 4 }}><strong>Task:</strong> {focused.currentTask || <span className="muted">none</span>}</div>
                    <div style={{ marginBottom: 6 }}><strong>Thinking:</strong> {focused.thought ? <em>"{focused.thought}"</em> : <span className="muted">—</span>}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3, fontSize: 10, color: '#cbe9df' }}>
                        <div>Mood {pct(focused.mood)}</div>
                        <div>Reputation {pct(focused.reputation)}</div>
                        <div>Risk {pct(focused.riskLevel)}</div>
                        <div>Momentum {pct(focused.momentum)}</div>
                        <div>Energy {pct(focused.energy)}</div>
                        <div>Doing: {focused.activity || '—'}</div>
                    </div>
                </div>
            )}
        </Panel>
    );
}
