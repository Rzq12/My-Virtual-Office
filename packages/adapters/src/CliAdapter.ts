import { spawn } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { InferenceAdapter, CompletionRequest, CompletionResponse, LLMMessage } from '@agent-office/core';

/**
 * Runs inference through a locally installed, logged-in CLI instead of an API key.
 * - ClaudeCliAdapter uses `claude -p` (Claude Pro/Max login via Claude Code)
 * - CodexCliAdapter uses `codex exec` (ChatGPT Plus/Pro login via Codex CLI)
 */
export class ClaudeCliAdapter implements InferenceAdapter {
    public readonly provider = 'claude-cli';
    public readonly isLocal = false;

    constructor(private command: string = 'claude', private timeoutMs: number = 120000) { }

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
        const start = Date.now();
        const { system, prompt } = splitMessages(request.messages);
        const args = [
            '-p',
            '--model', request.model,
            '--output-format', 'text',
            // Pure text completion: no built-in tools, MCP servers, hooks or saved sessions
            '--tools', '',
            '--strict-mcp-config',
            '--setting-sources', '',
            '--no-session-persistence',
            '--system-prompt', system || 'You are an agent in a virtual office simulation. Follow the output format you are given.'
        ];
        const content = await runCli(this.command, args, prompt, this.timeoutMs, false);
        return { content: content.trim(), usage: { prompt: 0, completion: 0 }, latency: Date.now() - start };
    }
}

export class CodexCliAdapter implements InferenceAdapter {
    public readonly provider = 'codex-cli';
    public readonly isLocal = false;

    constructor(private command: string = 'codex', private timeoutMs: number = 120000) { }

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
        const start = Date.now();
        const { system, prompt } = splitMessages(request.messages);

        // codex exec prints progress to stdout; the final answer is read from --output-last-message
        const dir = await mkdtemp(join(tmpdir(), 'agent-office-codex-'));
        const outFile = join(dir, 'last-message.txt');
        const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--output-last-message', outFile];
        if (request.model) args.push('--model', request.model);
        args.push('-');

        try {
            // npm installs codex as a .cmd shim on Windows, which needs a shell to launch
            const stdout = await runCli(this.command, args, system ? `${system}\n\n${prompt}` : prompt, this.timeoutMs, process.platform === 'win32');
            const lastMessage = await readFile(outFile, 'utf8').catch(() => '');
            return { content: (lastMessage || stdout).trim(), usage: { prompt: 0, completion: 0 }, latency: Date.now() - start };
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
}

function splitMessages(messages: LLMMessage[]): { system: string; prompt: string } {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const rest = messages.filter(m => m.role !== 'system');
    const prompt = rest.length === 1
        ? rest[0].content
        : rest.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
    return { system, prompt };
}

function runCli(command: string, args: string[], input: string, timeoutMs: number, useShell: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, useShell ? args.map(a => `"${a}"`) : args, {
            shell: useShell,
            windowsHide: true
        });

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('error', err => {
            clearTimeout(timer);
            reject(new Error(`Failed to start "${command}": ${err.message}. Is it installed and on PATH?`));
        });
        child.on('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve(stdout);
            else reject(new Error(`${command} exited with code ${code}: ${(stderr || stdout).slice(0, 500)}`));
        });

        child.stdin.end(input);
    });
}
