import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionBus } from '../lib/bus.js';

const CLOCK = 1760000000000;

/**
 * A Host double with a REAL inbox shape.
 *
 * `nextTurn` / `nextStep` mirror the driver-owned inbox: two separate arrays, each item carrying the
 * `id`, a `source`, and `content` parts. `status` mirrors `agent.status`.
 */
function createHost(options = {}) {
  const inbox = {
    nextTurn: options.nextTurn ?? [],
    nextStep: options.nextStep ?? [],
  };
  const cancels = [];
  const queueMutations = [];
  const agent = {
    status: options.status ?? 'running',
    inbox,
    cancel(request, opts) {
      cancels.push({ request, opts });
      // Mirror the platform: `keepInbox: true` means the queue is NOT touched.
      if (opts?.keepInbox !== true) {
        inbox.nextTurn = [];
        inbox.nextStep = [];
      }
    },
  };
  const sessions = [
    { sessionId: 'session-main0001', cwd: 'C:\\work\\a', updatedAt: CLOCK, running: options.status === 'running', agentAvailable: true, projections: { values: { title: 'Main' } } },
    { sessionId: 'session-other002', cwd: 'C:\\work\\b', updatedAt: CLOCK - 1000, running: false, agentAvailable: true, projections: { values: { title: 'Other workspace' } } },
  ];
  const host = {
    sessions,
    agent,
    cancels,
    queueMutations,
    sessionController: {
      async list() {
        return { items: sessions };
      },
      async inspect() {
        return { meta: { id: 'session-main0001', cwd: 'C:\\work\\a' }, inheritedEventCount: 0, events: [] };
      },
      async resolveAgent(sessionId) {
        if (options.unattached === true) return { error: { code: 'session/not-found' } };
        if (sessionId !== 'session-main0001' && sessionId !== 'session-other002') return { error: { code: 'session/not-found' } };
        return { agent };
      },
      cancel(request) {
        cancels.push({ viaController: true, request });
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        return { accepted: true };
      },
      async updateQueue(request) {
        queueMutations.push(request);
        if (options.updateQueueFails?.includes(request.itemId) === true) {
          const error = new Error(`[session/queue-item-not-found] ${request.itemId} is gone`);
          error.code = 'session/queue-item-not-found';
          throw error;
        }
        // Remove from whichever list holds it.
        inbox.nextStep = inbox.nextStep.filter((m) => m.id !== request.itemId);
        inbox.nextTurn = inbox.nextTurn.filter((m) => m.id !== request.itemId);
        return { accepted: true };
      },
    },
    get(name) {
      if (name === 'agents') return { get: () => agent };
      return undefined;
    },
  };
  return host;
}

function createBus(host, config = {}) {
  let counter = 0;
  return new SessionBus({
    ctx: host,
    config: { audit: false, persistState: false, spoolLongMessages: false, ...config },
    persist: false,
    clock: () => CLOCK,
    idFactory: () => `msg${String(++counter).padStart(9, '0')}`,
  });
}

const senderA = { id: 'session-main0001', title: 'Main', cwd: 'C:\\work\\a' };
const senderB = { id: 'session-other002', title: 'Other workspace', cwd: 'C:\\work\\b' };

/** One queued message with a text part. */
const queued = (id, text) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
});

// ── bus_inbox: read-only, two lists, capped previews ─────────────────────────

test('inbox reports both lists separately with their own indices', async () => {
  const host = createHost({
    nextTurn: [queued('t1', 'first turn'), queued('t2', 'second turn')],
    nextStep: [queued('s1', 'step input')],
  });
  const bus = createBus(host);
  const view = await bus.inbox({ session: 'self', sender: senderA });

  assert.equal(view.nextTurn.length, 2);
  assert.equal(view.nextStep.length, 1);
  // Indices are LOCAL to each list — never a merged sequence.
  assert.deepEqual(view.nextTurn.map((row) => row.index), [0, 1]);
  assert.deepEqual(view.nextStep.map((row) => row.index), [0]);
  assert.equal(view.pendingCount, 3);
  assert.equal(view.running, true);
  assert.equal(view.status, 'running');
});

test('inbox never mutates the queue (read-only)', async () => {
  const host = createHost({ nextTurn: [queued('t1', 'x')], nextStep: [] });
  const bus = createBus(host);
  await bus.inbox({ session: 'self', sender: senderA });
  await bus.inbox({ session: 'self', sender: senderA });
  assert.equal(host.agent.inbox.nextTurn.length, 1, 'reading must not consume the queue');
  assert.equal(host.queueMutations.length, 0, 'reading must not call updateQueue');
  assert.equal(host.cancels.length, 0, 'reading must not cancel');
});

test('preview is capped at 80 characters', async () => {
  const long = 'A'.repeat(500);
  const host = createHost({ nextTurn: [queued('t1', long)], nextStep: [] });
  const bus = createBus(host);
  const view = await bus.inbox({ session: 'self', sender: senderA });
  const preview = view.nextTurn[0].preview;
  assert.equal(preview.length, 80, 'preview must be at most 80 chars');
  assert.ok(preview.endsWith('…'), 'a truncated preview says so');
});

test('cross-workspace inbox hides previews but keeps counts', async () => {
  const host = createHost({ nextTurn: [queued('t1', 'secret draft')], nextStep: [] });
  const bus = createBus(host);
  // senderB is in C:\work\b; target session-main0001 is in C:\work\a
  const view = await bus.inbox({ session: 'session-main0001', sender: senderB });

  assert.equal(view.crossWorkspace, true);
  assert.equal(view.previewsHidden, true);
  assert.equal(view.nextTurn.length, 1, 'the shape is still reported');
  assert.equal(view.nextTurn[0].preview, undefined, 'content must NOT leak across a workspace boundary');
  assert.equal(view.pendingCount, 1);
});

test('same-workspace inbox shows previews', async () => {
  const host = createHost({ nextTurn: [queued('t1', 'visible draft')], nextStep: [] });
  const bus = createBus(host);
  const view = await bus.inbox({ session: 'self', sender: senderA });
  assert.equal(view.crossWorkspace, false);
  assert.equal(view.previewsHidden, false);
  assert.equal(view.nextTurn[0].preview, 'visible draft');
});

test('inbox on an unattached Session says so instead of reporting an empty queue', async () => {
  const host = createHost({ unattached: true });
  const bus = createBus(host);
  await assert.rejects(
    () => bus.inbox({ session: 'self', sender: senderA }),
    (error) => {
      assert.equal(error.code, 'session_unavailable');
      // The distinction that matters: "cannot read" must not look like "nothing queued".
      assert.match(error.message, /not attached/);
      return true;
    },
  );
});

// ── bus_cancel: stop and discard are SEPARATE ────────────────────────────────

test('cancel stops the turn and LEAVES THE QUEUE INTACT by default', async () => {
  const host = createHost({ status: 'running', nextTurn: [queued('t1', 'keep me')], nextStep: [queued('s1', 'keep me too')] });
  const bus = createBus(host);
  const result = await bus.cancel({ session: 'self', sender: senderA });

  assert.equal(result.stoppedRunningTurn, true);
  assert.equal(result.discardRequested, false);
  assert.equal(result.discarded, 0);
  assert.deepEqual(result.queueBefore, { nextTurn: 1, nextStep: 1, pendingCount: 2 });
  // THE POINT: the platform's keepInbox behaviour is preserved.
  assert.equal(host.agent.inbox.nextTurn.length, 1, 'queue must survive a plain cancel');
  assert.equal(host.agent.inbox.nextStep.length, 1);
  assert.equal(host.queueMutations.length, 0, 'a plain cancel must not remove anything');
});

test('cancel with discardQueue removes items one by one and reports the count', async () => {
  const host = createHost({ status: 'running', nextTurn: [queued('t1', 'a'), queued('t2', 'b')], nextStep: [queued('s1', 'c')] });
  const bus = createBus(host);
  const result = await bus.cancel({ session: 'self', sender: senderA, discardQueue: true });

  assert.equal(result.discardRequested, true);
  assert.equal(result.discarded, 3);
  assert.deepEqual(result.discardFailures, []);
  assert.deepEqual(result.queueAfter, { nextTurn: 0, nextStep: 0, pendingCount: 0 });
  assert.equal(host.queueMutations.length, 3, 'one remove per queued item');
  assert.ok(host.queueMutations.every((m) => m.action.kind === 'remove'));
});

test('a partially failed discard is reported, never rounded up to success', async () => {
  const host = createHost({
    status: 'running',
    nextTurn: [queued('t1', 'a'), queued('t2', 'b')],
    nextStep: [],
    updateQueueFails: ['t2'],
  });
  const bus = createBus(host);
  const result = await bus.cancel({ session: 'self', sender: senderA, discardQueue: true });

  assert.equal(result.discarded, 1, 'one succeeded');
  assert.equal(result.discardFailures.length, 1, 'one failed and is listed');
  assert.equal(result.discardFailures[0].itemId, 't2');
  assert.equal(result.discardFailures[0].code, 'session/queue-item-not-found');
  // The state after a partial discard is stated, not hidden.
  assert.deepEqual(result.queueAfter, { nextTurn: 1, nextStep: 0, pendingCount: 1 });
});

test('cancel of an idle Session reports that nothing was interrupted', async () => {
  const host = createHost({ status: 'idle', nextTurn: [queued('t1', 'queued')], nextStep: [] });
  const bus = createBus(host);
  const result = await bus.cancel({ session: 'self', sender: senderA });
  assert.equal(result.statusBefore, 'idle');
  assert.equal(result.stoppedRunningTurn, false);
  assert.equal(host.agent.inbox.nextTurn.length, 1, 'an idle cancel still must not eat the queue');
});

test('cancel across a workspace boundary is refused when the Host disallows it', async () => {
  const host = createHost({ status: 'running' });
  const bus = createBus(host, { allowCrossWorkspace: false });
  await assert.rejects(
    () => bus.cancel({ session: 'session-main0001', sender: senderB }),
    (error) => {
      assert.equal(error.code, 'cross_workspace_disabled');
      return true;
    },
  );
  assert.equal(host.cancels.length, 0, 'a refused cancel must not reach the platform');
});

test('cancel on an unattached Session refuses instead of pretending it stopped', async () => {
  const host = createHost({ unattached: true });
  const bus = createBus(host);
  await assert.rejects(
    () => bus.cancel({ session: 'self', sender: senderA }),
    (error) => {
      assert.equal(error.code, 'session_unavailable');
      return true;
    },
  );
});
