// Generate disposable evidence with Dexter's own stores/serializers, not copied fixtures.
// Never opens an operator workspace or starts the CLI, scheduler, agents or inference.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerDexterTools } from '../dist/extension.js';
import { registerBoardTools } from '../dist/board.js';
import { createDeusServer } from '../dist/mcp.js';

async function tree(root, dir = root) {
  const entries = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) entries.push(...(await tree(root, path)));
    else {
      assert.ok(item.isFile(), 'Fixture must not contain links or special files');
      entries.push([
        relative(root, path),
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]);
    }
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

export async function checkCurrentReaders(checkout, root) {
  const load = (path) => import(pathToFileURL(join(checkout, 'engine/dist', path)).href);
  const [{ SQLiteSchedulerPersistence }, models, { renderRunMetadata }, { DexterConfig }] =
    await Promise.all([
      load('backends/scheduler.js'),
      load('models.js'),
      load('backends/runstore/filesystem.js'),
      load('config/schema.js'),
    ]);
  const {
    Issue,
    IssueKind,
    IssueStatus,
    MergeRequest,
    Note,
    Review,
    ReviewVerdict,
    WikiPage,
    Role,
    MessageType,
  } = models;
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const put = async (path, text) => {
    const parts = path.split('/');
    await mkdir(join(workspace, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(workspace, path), text);
  };
  await DexterConfig.default().save(join(workspace, 'dexter.config.json'));
  const scheduler = new SQLiteSchedulerPersistence(join(workspace, 'scheduler.sqlite3'));
  await scheduler.initialize();
  const run = await scheduler.runs.leaseRun(Role.IMPLEMENTER, {
    host: hostname(),
    pid: process.pid,
    issue: 'ISSUE-0002',
  });
  const retired = await scheduler.runs.leaseRun(Role.REVIEWER, {
    host: hostname(),
    pid: process.pid,
    issue: 'ISSUE-0003',
  });
  await scheduler.runs.retireRun(retired.id);
  await scheduler.notifier.publish(MessageType.RUN_STARTED, {
    run: run.id,
    issue: 'ISSUE-0002',
    workspaceId: 'WD-0001',
    body: 'PRIVATE EVENT BODY',
  });
  await scheduler.notifier.publish(MessageType.RUN_RETIRED, {
    run: retired.id,
    issue: 'ISSUE-0003',
    note: 'retired',
  });
  assert.deepEqual(await scheduler.validatePersistence(), []);

  for (const input of [
    { id: 'ISSUE-0001', kind: IssueKind.EPIC, status: IssueStatus.TRACKING },
    { id: 'ISSUE-0002', status: IssueStatus.READY },
    { id: 'ISSUE-0003', status: IssueStatus.CLOSED },
    { id: 'ISSUE-0004', status: IssueStatus.REJECTED },
    { id: 'ISSUE-0005', status: IssueStatus.OPEN, dependsOn: ['ISSUE-0004'] },
    { id: 'ISSUE-0006', status: IssueStatus.OPEN, dependsOn: ['ISSUE-0003'] },
  ]) {
    const issue = Issue.create({
      kind: IssueKind.TASK,
      parent: 'ISSUE-0001',
      title: 'Useful product outcome',
      body: 'Original contract: 字🙂 preserved.',
      ...input,
    });
    const doc = issue.toDoc();
    assert.ok(Issue.fromDoc(doc).equals(issue));
    await put(`forge/issues/${issue.id}-product.md`, doc.render());
  }
  const mr = MergeRequest.create({
    id: 'MR-0001',
    issue: 'ISSUE-0002',
    workspaceId: 'WD-0001',
    body: 'Engineering evidence',
  });
  await put('forge/merge_requests/MR-0001.md', mr.toDoc().render());
  const created = '2020-01-01T01:00:00Z';
  const review = Review.create({
    mr: mr.id,
    reviewer: run.id,
    seq: 1,
    verdict: ReviewVerdict.APPROVED,
    created,
    summary: 'Accepted engineering review',
  });
  await put('forge/reviews/MR-0001/0001.md', review.toDoc().render());
  for (const target of ['ISSUE-0002', mr.id])
    await put(
      `forge/notes/${target}/0001.md`,
      Note.create({
        target,
        author: 'operator',
        seq: 1,
        body: 'Retained note',
      })
        .toDoc()
        .render(),
    );
  const wiki = WikiPage.create({
    slug: 'product-contract',
    title: 'Product',
    body: 'Wiki evidence',
  });
  await put('forge/wiki/product-contract.md', wiki.toDoc().render());

  // Canonical metadata includes nulls and counters emitted by the current serializer.
  // Set explicit times for deterministic cohorts without changing any host clock.
  const runMetadata = {
    run: run.id,
    role: Role.IMPLEMENTER,
    issue: 'ISSUE-0002',
    status: 'done',
    startedAt: created,
    updatedAt: '2020-01-01T01:00:02Z',
    exitCode: 0,
    promptTokens: 123,
  };
  await put(`forge/runs/${run.id}/run.json`, renderRunMetadata(runMetadata));
  for (const [file, text] of Object.entries({
    'prompt.txt': 'Assignment 字🙂',
    'system.txt': 'System prompt',
    'stdout.txt': 'Actual transcript 字🙂',
    'stderr.txt': 'Retained stderr',
  }))
    await put(`forge/runs/${run.id}/${file}`, text);

  const registry = new Map();
  const registrar = { registerTool: (tool) => registry.set(tool.name, tool) };
  registerDexterTools(registrar);
  registerBoardTools(registrar);
  assert.deepEqual(
    [...registry.keys()].sort(),
    [
      'architecture_accept',
      'bots_live',
      'epic_create',
      'events_read',
      'issue_nudge',
      'issue_read',
      'issue_reject',
      'issue_relink',
      'issue_reprioritize',
      'issues_live',
      'issues_plan',
      'metrics',
      'mr_read',
      'probe',
      'run_read',
      'task_create',
      'wiki_read',
    ]
      .map((name) => `deus_dexter_${name}`)
      .sort(),
  );
  const direct = async (name, args) => {
    const result = await registry
      .get(name)
      .execute('contract', args, undefined, undefined, { cwd: workspace });
    return JSON.parse(result.content[0].text);
  };
  // Use the real notification codec at Dexter's supported safe-integer boundary.
  await scheduler.database.write(async (q) => {
    await q
      .updateTable('notification_revision')
      .set({ value: String(Number.MAX_SAFE_INTEGER - 1) })
      .where('id', '=', 1)
      .execute();
  });
  const finalEvent = await scheduler.notifier.publish(MessageType.NOTE_ADDED, {
    note: 'maximum sequence',
  });
  assert.equal(finalEvent.seq, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(await scheduler.validatePersistence(), []);
  const before = await tree(workspace);
  const app = await createDeusServer(workspace);
  const client = new Client({ name: 'deus-current-dexter', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await app.server.connect(b);
    await client.connect(a);
    const remote = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    for (const call of [direct, remote]) {
      const read = (name, args = {}) => call(`deus_dexter_${name}`, { workspace, ...args });
      for (const [kind, idField, id, sections] of [
        ['issue', 'issue', 'ISSUE-0002', ['summary', 'metadata', 'body', 'notes']],
        ['mr', 'mr', mr.id, ['summary', 'metadata', 'body', 'reviews', 'notes']],
        ['wiki', 'slug', wiki.slug, ['summary', 'metadata', 'body']],
        ['run', 'run', run.id, ['metadata', 'assignment', 'system', 'transcript', 'stderr']],
      ])
        for (const section of sections) {
          let cursor = null,
            text = '',
            pages = 0;
          do {
            const page = await read(`${kind}_read`, { [idField]: id, section, cursor, limit: 43 });
            assert.ok(Buffer.byteLength(page.text) <= 43);
            text += page.text;
            cursor = page.nextCursor;
            assert.ok(++pages < 1000);
          } while (cursor);
          assert.ok(text.length, `${kind}/${section}`);
          assert.ok(!text.includes('�'), `${kind}/${section} preserves UTF-8`);
          if (kind === 'run' && section === 'transcript')
            assert.equal(text, 'Actual transcript 字🙂');
        }
      const live = await read('issues_live', { cursor: null, limit: 20 });
      assert.deepEqual(
        live.records.map((i) => i.id),
        ['ISSUE-0001', 'ISSUE-0002', 'ISSUE-0005', 'ISSUE-0006'],
      );
      assert.equal(live.records.find((i) => i.id === 'ISSUE-0002').claimed, true);
      assert.equal(live.records.find((i) => i.id === 'ISSUE-0005').ready, false);
      assert.equal(live.records.find((i) => i.id === 'ISSUE-0006').ready, true);
      assert.ok((await read('issues_plan', { cursor: null, limit: 20 })).records.length);
      const bots = await read('bots_live');
      assert.equal(bots.runs.length, 1);
      assert.equal(bots.runs[0].id, run.id);
      assert.equal(bots.runs[0].active, true);
      const newest = await read('events_read', { cursor: null, limit: 1 });
      assert.equal(newest.events[0].seq, Number.MAX_SAFE_INTEGER);
      const first = await read('events_read', { cursor: newest.nextCursor, limit: 1 });
      const second = await read('events_read', { cursor: first.nextCursor, limit: 1 });
      assert.deepEqual([first.events[0].seq, second.events[0].seq], [2, 1]);
      assert.equal(second.nextCursor, null);
      assert.equal(second.events[0].workdir, 'WD-0001');
      assert.ok(!JSON.stringify(second).includes('PRIVATE EVENT BODY'));
      const m = await read('metrics', {
        since: '2020-01-01',
        until: '2020-01-02',
        utcOffsetMinutes: 0,
      });
      assert.equal(m.days[0].runs.total.done, 1);
      assert.equal(m.days[0].runs.total.durationMs.sum, 2000);
      assert.equal(m.days[0].runs.total.promptTokens.sum, 123);
      assert.deepEqual(m.days[0].workspaceActivity.reviewVerdicts, { approved: 1 });
    }
  } finally {
    await app.close();
    await client.close();
  }
  assert.deepEqual(
    await tree(workspace),
    before,
    'All readers must leave current Dexter evidence unchanged',
  );
  console.log(
    'Current Dexter persistence: all 17 artifact sections, board, leases, events and metrics passed through Pi/MCP; evidence unchanged.',
  );
}
