import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { Check } from 'typebox/value';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { registerDexterTools } from './extension.js';
import { registerBoardTools } from './board.js';
import { packageRoot, verifySkillIntegrity } from './resources.js';
import { redact, textResult } from './process.js';
/** Preserve board path guards without exposing a generic filesystem API. */
async function boardPaths(cwd) {
    for (const dir of ['forge', 'forge/issues', 'forge/.candidates']) {
        try {
            const path = join(cwd, dir);
            const info = await lstat(path);
            if (!info.isDirectory())
                throw new Error('Board path must be a directory, not a link');
            for (const name of await readdir(path)) {
                const entry = await lstat(join(path, name));
                if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
                    throw new Error('Symbolic links and special files are not supported');
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
}
/** One server is bound to one operator-selected workspace, on the server host. */
export async function createDeusServer(workspace) {
    if (!isAbsolute(workspace))
        throw new Error('--workspace must be absolute');
    const cwd = await realpath(workspace);
    if (!(await stat(cwd)).isDirectory())
        throw new Error('Workspace must be a directory');
    await verifySkillIntegrity();
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const kernel = await readFile(join(packageRoot, 'prompts/kernel.md'), 'utf8');
    const tools = new Map();
    const registry = {
        registerTool(tool) {
            if (tools.has(tool.name))
                throw new Error(`Duplicate tool: ${tool.name}`);
            tools.set(tool.name, tool);
        },
    };
    registerDexterTools(registry);
    registerBoardTools(registry);
    const server = new Server({ name: 'deus', version: manifest.version }, {
        capabilities: { tools: {} },
        instructions: `Deus runs on the Dexter host, bound to workspace ${JSON.stringify(cwd)}. Use that exact workspace in tool arguments. Only Dexter tools are exposed. Obtain skills and ordinary filesystem access separately on the client. Never automatically replay an interrupted mutation.\n\n${kernel}\n\nCalls run in the foreground. Cancellation or disconnection aborts running commands; their outcome may be uncertain. Reconnect and inspect live state. Public research uses the client's web tools; Deus does not start model sessions.`,
    });
    const stop = new AbortController();
    let pending = Promise.resolve();
    server.onclose = () => stop.abort();
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [...tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: {
                ...tool.parameters,
                type: 'object',
                additionalProperties: false,
            },
            annotations: tool.annotations ?? {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
            },
        })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const execute = async () => {
            const signal = AbortSignal.any([extra.signal, stop.signal]);
            try {
                signal.throwIfAborted();
                const tool = tools.get(request.params.name);
                if (!tool)
                    throw new Error('Unknown Deus tool');
                const args = request.params.arguments ?? {};
                if (!Check({ ...tool.parameters, additionalProperties: false }, args))
                    throw new Error('Invalid tool arguments');
                if ('workspace' in args && args.workspace !== cwd)
                    throw new Error('workspace must equal the configured server workspace');
                if (['deus_dexter_issues_live', 'deus_dexter_issues_plan'].includes(tool.name))
                    await boardPaths(cwd);
                signal.throwIfAborted();
                const result = await tool.execute(String(extra.requestId), args, signal, undefined, {
                    cwd,
                });
                return { content: result.content };
            }
            catch (error) {
                return {
                    isError: true,
                    content: textResult(redact(error instanceof Error ? error.message : String(error)))
                        .content,
                };
            }
        };
        // Serialize this connection to avoid overlapping mutations.
        const result = pending.then(execute);
        pending = result.then(() => { }, () => { });
        return result;
    });
    return {
        server,
        workspace: cwd,
        async close() {
            stop.abort();
            await server.close();
            await pending;
        },
    };
}
