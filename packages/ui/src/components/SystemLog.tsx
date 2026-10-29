import React, { useState, useEffect, useRef } from 'react';
import { eventBus } from '../events';
import { Panel } from './Panel';
import { agentColor } from '../store';

interface LogEntry {
    id: number;
    agent: string;
    action: string;
    thought: string;
    time: string;
}

const actionIcons: Record<string, string> = {
    'work': '💻', 'talk': '💬', 'idle': '😌',
    'use_tool': '🔧', 'move': '🚶', 'think': '💡'
};

export function SystemLog() {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const scrollRef = useRef<HTMLDivElement>(null);
    const idRef = useRef(0);

    const lastEntryPerAgent = useRef<Record<string, string>>({});

    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;

            // Deduplicate: skip if same agent + action + thought as last time
            const key = `${detail.agent}:${detail.action}:${detail.thought}`;
            if (lastEntryPerAgent.current[detail.agent] === key) return;
            lastEntryPerAgent.current[detail.agent] = key;

            setLogs(prev => {
                const newLog: LogEntry = { id: idRef.current++, ...detail };
                return [...prev, newLog].slice(-60);
            });
        };
        eventBus.addEventListener('activity-log', handler);
        return () => eventBus.removeEventListener('activity-log', handler);
    }, []);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs]);

    return (
        <Panel id="activity-log" title="📊 Activity Log" subtitle="What each agent is doing and thinking">
            <div ref={scrollRef} className="scroll-list" style={{ maxHeight: 200, fontSize: 11, lineHeight: 1.5 }}>
                {logs.length === 0 && <p className="empty">Waiting for agent events...</p>}
                {logs.map(log => (
                    <div key={log.id} style={{
                        padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.04)',
                        display: 'flex', gap: 6, alignItems: 'flex-start'
                    }}>
                        <span style={{ color: '#7d82ad', minWidth: 58, flex: 'none' }}>{log.time}</span>
                        <span aria-hidden="true">{actionIcons[log.action] || '•'}</span>
                        <span>
                            <strong style={{ color: agentColor(log.agent) }}>{log.agent}</strong>
                            {' '}
                            <span style={{ color: '#9a9fc8' }}>{log.action}</span>
                            {log.thought && <span style={{ color: '#b8bce0', fontStyle: 'italic' }}> — "{log.thought}"</span>}
                        </span>
                    </div>
                ))}
            </div>
        </Panel>
    );
}
