import { spawn } from 'child_process';
import { mkdir, readFile, appendFile } from 'fs/promises';
import { resolve, relative, isAbsolute, join } from 'path';
import { tavily, type TavilyClient, type TavilySearchResponse } from '@tavily/core';

export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
}

const CODE_TIMEOUT_MS = 5000;
const MAX_OUTPUT = 4000;

export class ToolExecutor {
    private tavilyClient: TavilyClient | null = null;

    /** Agents can only read and write files inside this directory. */
    readonly workspaceDir: string;

    constructor(workspaceDir = process.env.AGENT_WORKSPACE || resolve(process.cwd(), 'workspace')) {
        this.workspaceDir = resolve(workspaceDir);
    }

    private getTavilyClient(): TavilyClient | null {
        if (this.tavilyClient) return this.tavilyClient;
        const apiKey = process.env.TAVILY_API_KEY;
        if (apiKey) {
            this.tavilyClient = tavily({ apiKey });
            return this.tavilyClient;
        }
        return null;
    }

    async execute(toolName: string, params: any, context: { agentName?: string } = {}): Promise<ToolResult> {
        const p = params || {};
        switch (toolName) {
            case 'code_execute':
                return this.executeCode(String(p.code || ''), String(p.language || 'javascript'));
            case 'web_search':
                return this.webSearch(String(p.query || ''));
            case 'write_note':
                return this.writeNote(String(p.content || ''), context.agentName || 'agent');
            case 'read_file':
                return this.readFile(String(p.path || ''));
            default:
                return { success: false, output: '', error: `Unknown tool: ${toolName}` };
        }
    }

    /**
     * Runs JavaScript in a separate Node process started with the permission model:
     * no file system, child process or worker access, an empty environment, and a hard timeout.
     * The code is passed on stdin, never through a shell.
     */
    executeCode(code: string, language: string): Promise<ToolResult> {
        return new Promise((done) => {
            if (!['javascript', 'js'].includes(language.toLowerCase())) {
                done({ success: false, output: '', error: 'Only JavaScript is supported for sandboxed execution.' });
                return;
            }
            if (!code.trim()) {
                done({ success: false, output: '', error: 'No code given.' });
                return;
            }

            const wrapped = `try {
  const __result = (function () {\n${code}\n})();
  if (__result !== undefined) console.log(typeof __result === 'string' ? __result : JSON.stringify(__result));
} catch (e) { console.error(e && e.message ? e.message : String(e)); process.exitCode = 1; }`;

            const child = spawn(process.execPath, ['--permission', '-'], {
                env: {},
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true
            });

            let stdout = '';
            let stderr = '';
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, CODE_TIMEOUT_MS);

            child.stdout.on('data', (chunk) => { if (stdout.length < MAX_OUTPUT) stdout += chunk; });
            child.stderr.on('data', (chunk) => { if (stderr.length < MAX_OUTPUT) stderr += chunk; });
            child.on('error', (err) => {
                clearTimeout(timer);
                done({ success: false, output: '', error: err.message });
            });
            child.on('close', (exitCode) => {
                clearTimeout(timer);
                if (timedOut) {
                    done({ success: false, output: stdout.trim(), error: `Timed out after ${CODE_TIMEOUT_MS / 1000}s.` });
                } else if (exitCode !== 0) {
                    done({ success: false, output: stdout.trim(), error: stderr.trim() || `Exited with code ${exitCode}` });
                } else {
                    done({ success: true, output: stdout.trim().slice(0, MAX_OUTPUT) });
                }
            });

            child.stdin.end(wrapped);
        });
    }

    private async webSearch(query: string): Promise<ToolResult> {
        if (!query.trim()) return { success: false, output: '', error: 'Empty search query.' };
        const client = this.getTavilyClient();
        if (client) {
            return this.webSearchTavily(query, client);
        }
        return this.webSearchDuckDuckGo(query);
    }

    private async webSearchTavily(query: string, client: TavilyClient): Promise<ToolResult> {
        try {
            const response = await client.search(query, { maxResults: 5 });

            const results = (response.results || [])
                .map((r: TavilySearchResponse['results'][number]) => `${r.title}: ${r.content}`)
                .join('\n\n');

            const output = results
                ? `Results:\n${results}`
                : `No results for "${query}".`;

            return { success: true, output };
        } catch (e: any) {
            return { success: false, output: '', error: `Tavily search failed: ${e.message}` };
        }
    }

    private async webSearchDuckDuckGo(query: string): Promise<ToolResult> {
        try {
            // Use a simple fetch to DuckDuckGo Instant Answer API (no API key needed)
            const encoded = encodeURIComponent(query);
            const res = await fetch(`https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1`);
            const data = await res.json();

            const abstract = data.Abstract || data.AbstractText || '';
            const relatedTopics = (data.RelatedTopics || []).slice(0, 3).map((t: any) => t.Text || '').join('; ');

            const output = abstract
                ? `Result: ${abstract}`
                : relatedTopics
                    ? `Related: ${relatedTopics}`
                    : `No direct results for "${query}".`;

            return { success: true, output };
        } catch (e: any) {
            return { success: false, output: '', error: `Search failed: ${e.message}` };
        }
    }

    /** Appends a note to workspace/notes/<agent>.md so the team's output survives restarts. */
    async writeNote(content: string, agentName: string): Promise<ToolResult> {
        if (!content.trim()) return { success: false, output: '', error: 'Empty note.' };
        try {
            const dir = join(this.workspaceDir, 'notes');
            await mkdir(dir, { recursive: true });
            const slug = agentName.toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'agent';
            await appendFile(join(dir, `${slug}.md`), `\n## ${new Date().toISOString()}\n${content.slice(0, 5000)}\n`, 'utf-8');
            return { success: true, output: `Note saved to notes/${slug}.md: "${content.slice(0, 60)}"` };
        } catch (e: any) {
            return { success: false, output: '', error: e.message };
        }
    }

    /** Resolves a path inside the workspace, or returns null if it would escape it. */
    resolveWorkspacePath(path: string): string | null {
        if (!path.trim() || isAbsolute(path)) return null;
        const full = resolve(this.workspaceDir, path);
        const rel = relative(this.workspaceDir, full);
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
        return full;
    }

    async readFile(path: string): Promise<ToolResult> {
        const full = this.resolveWorkspacePath(path);
        if (!full) {
            return { success: false, output: '', error: 'Only relative paths inside the agent workspace can be read.' };
        }
        try {
            const content = await readFile(full, 'utf-8');
            return { success: true, output: content.slice(0, 2000) };
        } catch (e: any) {
            if (e.code !== 'ENOENT') return { success: false, output: '', error: e.message };
            const files = await this.listWorkspaceFiles();
            const hint = files.length > 0 ? ` Available files: ${files.join(', ')}` : ' The workspace is empty.';
            return { success: false, output: '', error: `File not found: ${path}.${hint}` };
        }
    }

    /** Relative paths of up to 30 files in the workspace (used to point agents at real files). */
    async listWorkspaceFiles(): Promise<string[]> {
        const { readdir } = await import('fs/promises');
        try {
            const entries = await readdir(this.workspaceDir, { recursive: true, withFileTypes: true });
            return entries
                .filter(entry => entry.isFile())
                .map(entry => relative(this.workspaceDir, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
                .sort()
                .slice(0, 30);
        } catch {
            return [];
        }
    }
}
