import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, startTestServer, type ServerKit } from './helpers.js';

let kit: ServerKit | undefined;

afterEach(async () => {
  await kit?.cleanup();
  kit = undefined;
});

async function issueMember(
  k: ServerKit,
  botName: string,
  ownerName = botName + '-owner',
): Promise<string> {
  const res = await call(k.baseUrl, 'POST', '/admin/credentials/issue', k.adminToken, {
    botName,
    ownerName,
    role: 'member',
  });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

async function registerInboxOnlyAgent(
  k: ServerKit,
  token: string,
  botName: string,
): Promise<void> {
  const res = await call(k.baseUrl, 'POST', '/api/agents', token, {
    botName,
    url: 'inbox:',
  });
  expect(res.status).toBe(201);
}

describe('/api/inbox/* — central inbox for CLI agents', () => {
  describe('POST /api/inbox/:botName (enqueue)', () => {
    beforeEach(async () => { kit = await startTestServer('inbox-enqueue'); });

    it('enqueues with server-stamped from-* fields and returns 201', async () => {
      const ownerToken = await issueMember(kit!, 'recv-bot', 'recv-human');
      await registerInboxOnlyAgent(kit!, ownerToken, 'recv-bot');

      const senderToken = await issueMember(kit!, 'send-bot', 'send-human');
      const res = await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot', senderToken, {
        chatId: 'proj:demo:abc',
        content: 'hello world',
      });

      expect(res.status).toBe(201);
      expect(res.body.message).toMatchObject({
        targetBot: 'recv-bot',
        chatId: 'proj:demo:abc',
        fromBot: 'send-bot',
        fromOwner: 'send-human',
        content: 'hello world',
      });
      expect(res.body.message.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(typeof res.body.message.enqueuedAt).toBe('string');
    });

    it('rejects empty content with 400', async () => {
      const ownerToken = await issueMember(kit!, 'recv-bot');
      await registerInboxOnlyAgent(kit!, ownerToken, 'recv-bot');
      const senderToken = await issueMember(kit!, 'send-bot');
      const res = await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot', senderToken, {
        chatId: 'c1', content: '',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('content_required');
    });

    it('returns 404 when target bot is not registered', async () => {
      const senderToken = await issueMember(kit!, 'send-bot');
      const res = await call(kit!.baseUrl, 'POST', '/api/inbox/nobody', senderToken, {
        chatId: 'c1', content: 'hello',
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('agent_not_found');
    });

    it('rejects anonymous (no Bearer) with 401', async () => {
      const ownerToken = await issueMember(kit!, 'recv-bot');
      await registerInboxOnlyAgent(kit!, ownerToken, 'recv-bot');
      const res = await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot', null, {
        chatId: 'c1', content: 'hello',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/inbox/:botName/poll (long-poll pop)', () => {
    beforeEach(async () => { kit = await startTestServer('inbox-poll'); });

    it('returns an already-queued message immediately (no wait)', async () => {
      const ownerToken = await issueMember(kit!, 'recv-bot', 'recv-human');
      await registerInboxOnlyAgent(kit!, ownerToken, 'recv-bot');
      const senderToken = await issueMember(kit!, 'send-bot', 'send-human');
      await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot', senderToken, {
        chatId: 'c1', content: 'first',
      });

      const t0 = Date.now();
      const res = await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot/poll', ownerToken, {
        chatId: 'c1', wait: 5,
      });
      const elapsed = Date.now() - t0;

      expect(res.status).toBe(200);
      expect(res.body.message).toMatchObject({
        content: 'first', chatId: 'c1', fromBot: 'send-bot',
      });
      // Synchronous pop should return well under one tick (500ms).
      expect(elapsed).toBeLessThan(400);
    });

    it('atomically pops — a second poll on the same chatId returns null after timeout', async () => {
      const ownerToken = await issueMember(kit!, 'recv-bot');
      await registerInboxOnlyAgent(kit!, ownerToken, 'recv-bot');
      const senderToken = await issueMember(kit!, 'send-bot');
      await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot', senderToken, {
        chatId: 'c1', content: 'only-one',
      });

      const first = await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot/poll', ownerToken, {
        chatId: 'c1', wait: 0,
      });
      expect(first.body.message?.content).toBe('only-one');

      const second = await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot/poll', ownerToken, {
        chatId: 'c1', wait: 1,
      });
      expect(second.status).toBe(200);
      expect(second.body.message).toBeNull();
      expect(typeof second.body.waitedMs).toBe('number');
    });

    it('returns {message: null} after wait when no messages enqueued', async () => {
      const ownerToken = await issueMember(kit!, 'recv-bot');
      await registerInboxOnlyAgent(kit!, ownerToken, 'recv-bot');

      const t0 = Date.now();
      const res = await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot/poll', ownerToken, {
        chatId: 'c1', wait: 1,
      });
      const elapsed = Date.now() - t0;

      expect(res.status).toBe(200);
      expect(res.body.message).toBeNull();
      // wait=1 → expect ~1000ms; allow timing slop.
      expect(elapsed).toBeGreaterThanOrEqual(800);
    });

    it('non-owner caller gets 403 inbox_ownership_required', async () => {
      const ownerToken = await issueMember(kit!, 'recv-bot', 'alice');
      await registerInboxOnlyAgent(kit!, ownerToken, 'recv-bot');
      const otherToken = await issueMember(kit!, 'mallory-bot', 'mallory');

      const res = await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot/poll', otherToken, {
        wait: 0,
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('inbox_ownership_required');
    });

    it('same-owner second credential can drain (owner-bypass)', async () => {
      const machineA = await issueMember(kit!, 'recv-bot', 'shared-human');
      await registerInboxOnlyAgent(kit!, machineA, 'recv-bot');
      const machineB = await issueMember(kit!, 'recv-bot-laptop', 'shared-human');
      const senderToken = await issueMember(kit!, 'send-bot', 'someone-else');
      await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot', senderToken, {
        chatId: 'c1', content: 'reach-from-laptop',
      });

      const res = await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot/poll', machineB, {
        chatId: 'c1', wait: 0,
      });
      expect(res.status).toBe(200);
      expect(res.body.message?.content).toBe('reach-from-laptop');
    });

    it('chatId filter isolates queues', async () => {
      const ownerToken = await issueMember(kit!, 'recv-bot');
      await registerInboxOnlyAgent(kit!, ownerToken, 'recv-bot');
      const senderToken = await issueMember(kit!, 'send-bot');
      await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot', senderToken, {
        chatId: 'projA', content: 'A1',
      });
      await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot', senderToken, {
        chatId: 'projB', content: 'B1',
      });

      const a = await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot/poll', ownerToken, {
        chatId: 'projA', wait: 0,
      });
      expect(a.body.message?.content).toBe('A1');
      // projB still has its message; projA empty
      const aAgain = await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot/poll', ownerToken, {
        chatId: 'projA', wait: 0,
      });
      expect(aAgain.body.message).toBeNull();
      const b = await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot/poll', ownerToken, {
        chatId: 'projB', wait: 0,
      });
      expect(b.body.message?.content).toBe('B1');
    });
  });

  describe('GET /api/inbox/:botName (peek) + DELETE (clear)', () => {
    beforeEach(async () => { kit = await startTestServer('inbox-peek-clear'); });

    it('peeks without deleting; clear empties the queue', async () => {
      const ownerToken = await issueMember(kit!, 'recv-bot');
      await registerInboxOnlyAgent(kit!, ownerToken, 'recv-bot');
      const senderToken = await issueMember(kit!, 'send-bot');
      for (const i of [1, 2, 3]) {
        await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot', senderToken, {
          chatId: 'c1', content: 'msg' + i,
        });
      }

      const peek1 = await call(kit!.baseUrl, 'GET', '/api/inbox/recv-bot?chatId=c1', ownerToken);
      expect(peek1.status).toBe(200);
      expect(peek1.body.messages.map((m: any) => m.content)).toEqual(['msg1', 'msg2', 'msg3']);
      expect(peek1.body.count).toBe(3);
      // Peeks don't delete.
      const peek2 = await call(kit!.baseUrl, 'GET', '/api/inbox/recv-bot?chatId=c1', ownerToken);
      expect(peek2.body.count).toBe(3);

      const cleared = await call(
        kit!.baseUrl, 'DELETE', '/api/inbox/recv-bot?chatId=c1', ownerToken,
      );
      expect(cleared.status).toBe(200);
      expect(cleared.body.removed).toBe(3);
      const peek3 = await call(kit!.baseUrl, 'GET', '/api/inbox/recv-bot?chatId=c1', ownerToken);
      expect(peek3.body.count).toBe(0);
    });

    it('peek non-owner → 403', async () => {
      const ownerToken = await issueMember(kit!, 'recv-bot', 'alice');
      await registerInboxOnlyAgent(kit!, ownerToken, 'recv-bot');
      const other = await issueMember(kit!, 'mallory-bot', 'mallory');
      const res = await call(kit!.baseUrl, 'GET', '/api/inbox/recv-bot', other);
      expect(res.status).toBe(403);
    });

    it('clear without chatId clears all chats for that bot', async () => {
      const ownerToken = await issueMember(kit!, 'recv-bot');
      await registerInboxOnlyAgent(kit!, ownerToken, 'recv-bot');
      const senderToken = await issueMember(kit!, 'send-bot');
      await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot', senderToken, {
        chatId: 'cA', content: 'a',
      });
      await call(kit!.baseUrl, 'POST', '/api/inbox/recv-bot', senderToken, {
        chatId: 'cB', content: 'b',
      });
      const res = await call(kit!.baseUrl, 'DELETE', '/api/inbox/recv-bot', ownerToken);
      expect(res.body.removed).toBe(2);
    });
  });
});
