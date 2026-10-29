import React, { useMemo } from 'react';
import { Panel } from './Panel';
import { useOffice, agentColor } from '../store';

function pct(value: number): string {
    return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function AgentPulseBoard() {
    const agents = useOffice(s => s.agents);

    const sortedAgents = useMemo(
        () => [...agents].sort((a, b) => b.momentum - a.momentum),
        [agents]
    );

    return (
        <Panel
            id="agent-pulse"
            defaultCollapsed
            title="Agent Pulse"
            subtitle="Mood, risk, momentum"
        >
            {sortedAgents.length === 0 && <p className="empty">Waiting for live telemetry...</p>}
            <div className="scroll-list">
                {sortedAgents.map((agent) => (
                    <div key={agent.id} style={{
                        marginBottom: 8,
                        paddingBottom: 8,
                        borderBottom: '1px solid rgba(255,255,255,0.08)'
                    }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: agentColor(agent.name) }}>
                            {agent.name} <span style={{ fontWeight: 400, color: '#98ccb9' }}>({agent.action})</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 10, marginTop: 4, color: '#cbe9df' }}>
                            <div>Mood: {pct(agent.mood)}</div>
                            <div>Reputation: {pct(agent.reputation)}</div>
                            <div>Risk: {pct(agent.riskLevel)}</div>
                            <div>Momentum: {pct(agent.momentum)}</div>
                        </div>
                    </div>
                ))}
            </div>
        </Panel>
    );
}
