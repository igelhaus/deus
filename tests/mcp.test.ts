import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDeusServer } from '../src/mcp.js';
import { DexterPlugin } from '../src/dexter.js';
import { registerDexterTools } from '../src/extension.js';
import { registerBoardTools } from '../src/board.js';
import type { ToolRegistrar } from '../src/tool-registry.js';
import {
  fixture,
  environment,
  trust,
  program,
  waitFile,
  schedulerFixture,
  eventFixture,
} from './fixture.js';

async function setup(t: TestContext) {
  const { root, put } = await fixture(t);
  await schedulerFixture(root);
  const app = await createDeusServer(root);
  const client = new Client({ name: 'deus-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await app.server.connect(b);
  await client.connect(a);
  t.after(async () => {
    await app.close();
    await client.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0]!.text);
  };
  const reject = async (name: string, args: Record<string, unknown>) =>
    assert.equal((await client.callTool({ name, arguments: args })).isError, true);
  return { root, app, client, call, reject, put };
}

test('MCP exposes exactly the shared Dexter tools with accurate annotations and workspace binding', async (t) => {
  const { root, client, call, reject } = await setup(t);
  const tools = (await client.listTools()).tools;
  const shared: string[] = [];
  const registry: ToolRegistrar = {
    registerTool: (tool) => {
      shared.push(tool.name);
    },
  };
  for (const register of [registerDexterTools, registerBoardTools]) register(registry);
  assert.equal(shared.length, 17);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), shared.sort());
  assert.ok(tools.every((tool) => tool.name.startsWith('deus_dexter_')));
  for (const tool of tools)
    assert.deepEqual(
      [...(tool.inputSchema.required ?? [])].sort(),
      Object.keys(tool.inputSchema.properties ?? {}).sort(),
      tool.name,
    );
  for (const suffix of [
    'probe',
    'issues_live',
    'issues_plan',
    'issue_read',
    'mr_read',
    'wiki_read',
    'run_read',
    'bots_live',
    'events_read',
    'metrics',
  ])
    assert.equal(
      tools.find((tool) => tool.name === `deus_dexter_${suffix}`)!.annotations!.readOnlyHint,
      true,
    );
  assert.equal(
    tools.find((tool) => tool.name === 'deus_dexter_issue_reject')!.annotations!.readOnlyHint,
    false,
  );
  const metricsArgs = {
    workspace: root,
    since: '2026-01-01',
    until: '2026-01-02',
    utcOffsetMinutes: 180,
  };
  const unavailable = await client.callTool({
    name: 'deus_dexter_metrics',
    arguments: metricsArgs,
  });
  assert.equal(unavailable.isError, true);
  assert.ok(!JSON.stringify(unavailable).includes(root));
  for (const path of ['forge/runs', 'forge/reviews'])
    await mkdir(join(root, path), { recursive: true });
  const metrics = await call('deus_dexter_metrics', metricsArgs);
  assert.equal(metrics.days[0].runs.total.starts, 0);
  assert.deepEqual(metrics.days[0].runs.byRole, {});
  assert.deepEqual(metrics.days[0].workspaceActivity.reviewVerdicts, {});
  await reject('deus_dexter_metrics', { ...metricsArgs, role: 'all' });
  assert.equal(metrics.utcOffsetMinutes, 180);
  assert.ok(!JSON.stringify(metrics).includes(root));
  assert.ok(!JSON.stringify(metrics).includes('forge/'));
  await reject('deus_dexter_metrics', { ...metricsArgs, workspace: '/client/not-server' });
  for (const args of [
    { workspace: '/elsewhere', issue: 'ISSUE-0001' },
    { workspace: root, issue: '../escape' },
    { workspace: root, issue: 'ISSUE-0001', extra: true },
    { workspace: root, issue: 1 },
  ])
    await reject('deus_dexter_issue_nudge', args);
  await reject('deus_dexter_exec', {});
  await reject('absent', {});
});

test('MCP preserves trust refusal and current scheduler pagination', async (t) => {
  const { root, call, put } = await setup(t);
  trust(t, DexterPlugin.prototype, false);
  for (const [name, args] of [
    ['deus_dexter_epic_create', { title: 'task', body: '', workspace: root }],
    [
      'deus_dexter_task_create',
      { title: 'task', body: '', workspace: root, parent: null, dependencies: [], priority: 3 },
    ],
    ['deus_dexter_issue_reject', { workspace: root, issue: 'ISSUE-0001' }],
  ] as const) {
    const receipt = await call(name, args);
    assert.equal(receipt.status, 'rejected');
    assert.equal(receipt.profile, 'unknown');
  }
  await put('forge/wiki/sample.md', '---\nslug: sample\n---\n' + 'reader evidence '.repeat(30));
  const request = { workspace: root, slug: 'sample', section: 'body', cursor: null, limit: 16 };
  const first = await call('deus_dexter_wiki_read', request);
  const second = await call('deus_dexter_wiki_read', { ...request, cursor: first.nextCursor });
  assert.equal(second.revision, first.revision);
  for (const seq of [1, 2]) eventFixture(root, seq);
  const events = await call('deus_dexter_events_read', { workspace: root, cursor: null, limit: 1 });
  assert.equal(events.events[0].seq, 2);
  assert.equal(
    (
      await call('deus_dexter_events_read', {
        workspace: root,
        cursor: events.nextCursor,
        limit: 20,
      })
    ).events[0].seq,
    1,
  );
  await put('dexter.config.json', '{"heartbeat_ttl_seconds":60}');
  assert.deepEqual((await call('deus_dexter_bots_live', { workspace: root })).runs, []);
});

test('MCP board rejects linked directories and entries', async (t) => {
  const { root, reject } = await setup(t);
  const outside = await fixture(t);
  await mkdir(join(root, 'forge'));
  await symlink(outside.root, join(root, 'forge/issues'));
  const check = async () => {
    for (const name of ['deus_dexter_issues_live', 'deus_dexter_issues_plan'])
      await reject(name, { workspace: root, cursor: null, limit: 20 });
  };
  await check();
  await rm(join(root, 'forge/issues'));
  await mkdir(join(root, 'forge/issues'));
  await symlink(join(outside.root, 'missing.md'), join(root, 'forge/issues/ISSUE-0001.md'));
  await check();
  await rm(join(root, 'forge/issues/ISSUE-0001.md'));
  await symlink(outside.root, join(root, 'forge/.candidates'));
  await check();
});

test('MCP preserves board planning and snapshot pagination', async (t) => {
  const { root, call, reject, put } = await setup(t);
  trust(t);
  await put(
    'forge/issues/ISSUE-0001.md',
    '---\nid: ISSUE-0001\nkind: task\nstatus: open\nparent: ISSUE-0002\nworkdir: null\nmr: null\nassignee: null\ndepends_on: []\n---\nCoverage is 100%.\n',
  );
  await put(
    'forge/issues/ISSUE-0002.md',
    '---\nid: ISSUE-0002\nkind: epic\nstatus: open\nparent: null\ndepends_on: []\n---\nCompiler rejects invalid programs.\n',
  );
  assert.equal(
    (await call('deus_dexter_issues_live', { workspace: root, cursor: null, limit: 20 })).records
      .length,
    2,
  );
  assert.ok(
    (await call('deus_dexter_issues_plan', { workspace: root, cursor: null, limit: 20 })).records,
  );
  const page = await call('deus_dexter_issues_live', { workspace: root, cursor: null, limit: 1 });
  assert.equal(page.records.length, 1);
  const next = await call('deus_dexter_issues_live', {
    workspace: root,
    cursor: page.nextCursor,
    limit: 1,
  });
  assert.equal(next.records.length, 1);
  assert.notEqual(page.records[0].id, next.records[0].id);
  await reject('deus_dexter_issues_plan', { workspace: root, cursor: page.nextCursor, limit: 1 });
  await put('forge/issues/ISSUE-0003.md', '---\nid: ISSUE-0003\nstatus: open\n---\nProduct\n');
  await reject('deus_dexter_issues_live', { workspace: root, cursor: page.nextCursor, limit: 1 });
  assert.equal(
    (await call('deus_dexter_issues_live', { workspace: root, cursor: null, limit: 20 })).records
      .length,
    3,
  );
});

for (const disconnect of [false, true])
  test(`MCP ${disconnect ? 'disconnect' : 'cancellation'} reaps a fixture process without replaying its typed mutation`, async (t) => {
    const { root, client, call } = await setup(t);
    const executable = join(root, 'fixture.mjs'),
      marker = join(root, 'started');
    await program(
      executable,
      `import {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2))+'\\n');\nprocess.on('SIGTERM',()=>{appendFileSync(${JSON.stringify(marker)},'stopped\\n');process.exit(0)});\nsetInterval(()=>{},1000);\n`,
    );
    environment(t, 'DEXTER_BIN', executable);
    trust(t);
    const controller = new AbortController();
    const running = client.callTool(
      { name: 'deus_dexter_issue_reject', arguments: { issue: 'ISSUE-0001', workspace: root } },
      undefined,
      { signal: controller.signal },
    );
    const rejected = assert.rejects(running);
    await waitFile(marker);
    if (disconnect) await client.close();
    else controller.abort();
    await rejected;
    if (!disconnect)
      await call('deus_dexter_events_read', { workspace: root, cursor: null, limit: 1 });
    const lines = (await waitFile(marker, 'stopped')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]!), ['reject-issue', `--dir=${root}`, 'ISSUE-0001']);
    assert.equal(lines[1], 'stopped');
  });

test('MCP Forge readers redact once before UTF-8 pagination and retain the revision', async (t) => {
  const { root, call, put } = await setup(t);
  const raw = '字🙂 password=abcdefgh';
  const expected = '字🙂 password=[REDACTED]';
  const sha256 = createHash('sha256').update(expected).digest('hex');
  await put('forge/wiki/sample.md', '---\nslug: sample\n---\n' + raw);
  let cursor: string | null = null,
    collected = '';
  do {
    const page = await call('deus_dexter_wiki_read', {
      workspace: root,
      slug: 'sample',
      section: 'body',
      cursor,
      limit: 12,
    });
    assert.ok(Buffer.byteLength(page.text) <= 12);
    assert.equal(page.revision, sha256);
    collected += page.text;
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(collected, expected);
});
