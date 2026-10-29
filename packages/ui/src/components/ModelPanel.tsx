import React, { useState } from 'react';
import { getColyseusRoom } from '../game/Game';
import { Panel } from './Panel';
import { useOffice, agentColor, ProviderOption } from '../store';

interface Draft {
    provider: string;
    model: string;
}

function ProviderSelect({ value, providers, onChange, label }: {
    value: string;
    providers: ProviderOption[];
    onChange: (provider: string) => void;
    label: string;
}) {
    return (
        <select className="field" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}
            style={{ padding: '5px 6px', minWidth: 0, gridColumn: '1 / -1' }}>
            {providers.map(p => (
                <option key={p.id} value={p.id} disabled={!p.available} title={p.hint}>
                    {p.label}{p.available ? '' : ' — not configured'}
                </option>
            ))}
        </select>
    );
}

function ModelInput({ value, provider, onChange, label }: {
    value: string;
    provider: string;
    onChange: (model: string) => void;
    label: string;
}) {
    return (
        <input
            className="field"
            aria-label={label}
            list={`models-${provider}`}
            placeholder={provider === 'chatgpt' ? 'CLI default' : 'model id'}
            value={value}
            maxLength={100}
            onChange={(e) => onChange(e.target.value)}
            style={{ padding: '5px 6px', minWidth: 0 }}
        />
    );
}

/** Lets the user pick the provider and model each agent thinks with. Choices are saved on the server. */
export function ModelPanel() {
    const agents = useOffice(s => s.agents);
    const providers = useOffice(s => s.providers);
    const [drafts, setDrafts] = useState<Record<string, Draft>>({});
    const [bulk, setBulk] = useState<Draft>({ provider: 'claude', model: '' });

    const defaultModel = (provider: string) => providers.find(p => p.id === provider)?.defaultModel || '';

    const send = (agentId: string, draft: Draft) => {
        getColyseusRoom()?.send('set-agent-model', { agentId, provider: draft.provider, model: draft.model.trim() });
    };

    const updateDraft = (agentId: string, current: Draft, patch: Partial<Draft>) => {
        const next = { ...current, ...patch };
        if (patch.provider && patch.provider !== current.provider) next.model = defaultModel(patch.provider);
        setDrafts(d => ({ ...d, [agentId]: next }));
    };

    if (providers.length === 0) {
        return (
            <Panel id="agent-models" title="🧠 Agent Models" subtitle="Choose the LLM each agent uses">
                <p className="empty">Waiting for the server...</p>
            </Panel>
        );
    }

    return (
        <Panel id="agent-models" title="🧠 Agent Models" subtitle="Choose the LLM each agent uses">
            {providers.map(p => (
                <datalist key={p.id} id={`models-${p.id}`}>
                    {p.models.map(m => <option key={m} value={m} />)}
                </datalist>
            ))}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {agents.map(agent => {
                    const saved: Draft = { provider: agent.provider, model: agent.model };
                    const draft = drafts[agent.id] || saved;
                    const dirty = draft.provider !== saved.provider || draft.model.trim() !== saved.model;
                    return (
                        <div key={agent.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 8 }}>
                            <div style={{ fontSize: 12, marginBottom: 4 }}>
                                <strong style={{ color: agentColor(agent.name) }}>{agent.name}</strong>
                                <span className="muted" style={{ fontSize: 10 }}> · {agent.role}</span>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 4 }}>
                                <ProviderSelect label={`${agent.name} provider`} value={draft.provider} providers={providers}
                                    onChange={(provider) => updateDraft(agent.id, draft, { provider })} />
                                <ModelInput label={`${agent.name} model`} value={draft.model} provider={draft.provider}
                                    onChange={(model) => updateDraft(agent.id, draft, { model })} />
                                <button type="button" className="btn btn-primary btn-small" disabled={!dirty}
                                    onClick={() => { send(agent.id, draft); setDrafts(d => { const { [agent.id]: _, ...rest } = d; return rest; }); }}>
                                    Apply
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>

            <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
                <div style={{ fontSize: 11, marginBottom: 4 }} className="muted">Set every agent to:</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 4 }}>
                    <ProviderSelect label="Provider for all agents" value={bulk.provider} providers={providers}
                        onChange={(provider) => setBulk({ provider, model: defaultModel(provider) })} />
                    <ModelInput label="Model for all agents" value={bulk.model} provider={bulk.provider}
                        onChange={(model) => setBulk(b => ({ ...b, model }))} />
                    <button type="button" className="btn btn-small" onClick={() => { send('*', bulk); setDrafts({}); }}>
                        Apply all
                    </button>
                </div>
            </div>

            {providers.filter(p => !p.available && p.hint).map(p => (
                <p key={p.id} className="muted" style={{ fontSize: 10, margin: '8px 0 0' }}>{p.label}: {p.hint}</p>
            ))}
        </Panel>
    );
}
