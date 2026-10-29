import React, { useState } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { TaskBoard } from './components/TaskBoard';
import { TeamPanel } from './components/TeamPanel';
import { ModelPanel } from './components/ModelPanel';
import { LayoutEditor } from './components/LayoutEditor';
import { SystemLog } from './components/SystemLog';
import { ViralControlPanel } from './components/ViralControlPanel';
import { HighlightsFeed } from './components/HighlightsFeed';
import { AgentPulseBoard } from './components/AgentPulseBoard';
import { RelationshipGraph } from './components/RelationshipGraph';
import { EpisodeRecapPanel } from './components/EpisodeRecapPanel';
import { useOffice } from './store';

const CONNECTION_LABELS = {
    connecting: { text: 'Connecting…', color: '#fdcb6e' },
    connected: { text: 'Live', color: '#00b894' },
    error: { text: 'Disconnected', color: '#ff7675' }
} as const;

function Brand() {
    const connection = useOffice(s => s.connection);
    const endpoint = useOffice(s => s.endpoint);
    const engine = useOffice(s => s.engine);
    const agentCount = useOffice(s => s.agents.length);
    const status = CONNECTION_LABELS[connection];

    return (
        <header className="brand">
            <h1><span aria-hidden="true">🏢</span> AgentOffice</h1>
            <div className="brand-meta">
                <span className="pill" title={endpoint}>
                    <span className="dot" style={{ background: status.color }} aria-hidden="true" />
                    {status.text}
                </span>
                <span className="pill">🤖 {engine || 'Engine…'}</span>
                <span className="pill">👥 {agentCount}</span>
            </div>
            {connection === 'error' && (
                <p style={{ margin: 0, fontSize: 11, color: '#ff7675' }}>
                    Cannot reach the server at {endpoint} — retrying every few seconds. Start it with <code>npm run start --workspace=@agent-office/server</code>.
                </p>
            )}
        </header>
    );
}

export function App() {
    const [drawer, setDrawer] = useState<'none' | 'left' | 'right'>('none');
    const toggle = (side: 'left' | 'right') => setDrawer(current => (current === side ? 'none' : side));

    return (
        <>
            <nav className="mobile-bar" aria-label="Panels">
                <span className="title">🏢 AgentOffice</span>
                <button type="button" className="btn btn-small" aria-pressed={drawer === 'left'} onClick={() => toggle('left')}>👥 Team</button>
                <button type="button" className="btn btn-small" aria-pressed={drawer === 'right'} onClick={() => toggle('right')}>💬 Chat</button>
            </nav>

            <aside className={`sidebar left${drawer === 'left' ? ' open' : ''}`} aria-label="Team and tasks">
                <Brand />
                <TeamPanel />
                <TaskBoard />
                <ModelPanel />
                <AgentPulseBoard />
                <LayoutEditor />
            </aside>

            <aside className={`sidebar right${drawer === 'right' ? ' open' : ''}`} aria-label="Office feed">
                <ChatPanel />
                <SystemLog />
                <HighlightsFeed />
                <ViralControlPanel />
                <RelationshipGraph />
                <EpisodeRecapPanel />
            </aside>
        </>
    );
}
