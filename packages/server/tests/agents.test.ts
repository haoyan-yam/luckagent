import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { call, rawRequest, startTestServer, type ServerKit } from './helpers.js';

let kit: ServerKit | undefined;

afterEach(async () => {
  await kit?.cleanup();
  kit = undefined;
});


async function issueMember(k: ServerKit, name = 'cli-bot'): Promise<string> {
  const res = await call(k.baseUrl, 'POST', '/admin/credentials/issue', k.adminToken, {
    botName: name,
    ownerName: name + '-owner',
    role: 'member',
  });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

async function issueMemberWithOwner(
  k: ServerKit,
  botName: string,
  ownerName: string,
): Promise<string> {
  const res = await call(k.baseUrl, 'POST', '/admin/credentials/issue', k.adminToken, {
    botName, ownerName, role: 'member',
  });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

describe('/api/agents — routes + audit (token-auth era)', () => {
  it('POST /api/agents creates a row; body.botName missing → falls back to cred.botName (legacy 1:1)', async () => {
    kit = await startTestServer('agents-register');
    const token = await issueMember(kit, 'alice-bot');
    const res = await call(kit.baseUrl, 'POST', '/api/agents', token, {
      url: 'http://10.0.0.1:9100',
    });
    expect(res.status).toBe(201);
    expect(res.body.botName).toBe('alice-bot');
    expect(res.body.url).toBe('http://10.0.0.1:9100');
    expect(res.body.talkSecret).toBeUndefined();
    expect(res.body.visible).toBe(true);
    expect(res.body.registeredAt).toBe(res.body.lastSeenAt);
  });

  it('POST /api/agents with body.botName lets one credential own many bots', async () => {
    kit = await startTestServer('agents-multi-bot');
    const token = await issueMember(kit, 'bridge-cred');
    const a = await call(kit.baseUrl, 'POST', '/api/agents', token, {
      botName: 'feishu-alpha', url: 'http://a:9100',
    });
    const b = await call(kit.baseUrl, 'POST', '/api/agents', token, {
      botName: 'telegram-beta', url: 'http://b:9100',
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.botName).toBe('feishu-alpha');
    expect(b.body.botName).toBe('telegram-beta');
  });

  it('POST /api/agents → 403 name_squat when a different cred tries an existing botName', async () => {
    kit = await startTestServer('agents-anti-squat');
    const tokenA = await issueMember(kit, 'cred-a');
    const tokenB = await issueMember(kit, 'cred-b');
    await call(kit.baseUrl, 'POST', '/api/agents', tokenA, {
      botName: 'shared-name', url: 'http://a',
    });
    const squat = await call(kit.baseUrl, 'POST', '/api/agents', tokenB, {
      botName: 'shared-name', url: 'http://b',
    });
    expect(squat.status).toBe(403);
    expect(squat.body.error).toBe('name_squat');
  });

  it('POST /api/agents → 400 if url missing', async () => {
    kit = await startTestServer('agents-no-url');
    const token = await issueMember(kit);
    const res = await call(kit.baseUrl, 'POST', '/api/agents', token, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('url_required');
  });

  it('POST /api/agents/bulk registers every entry, returns per-entry status', async () => {
    kit = await startTestServer('agents-bulk');
    const token = await issueMember(kit, 'bridge-cred');
    const res = await call(kit.baseUrl, 'POST', '/api/agents/bulk', token, {
      bots: [
        { botName: 'feishu-alpha', url: 'http://a:9100' },
        { botName: 'telegram-beta', url: 'http://b:9100', visible: false },
        { botName: 'bad-no-url' }, // missing url
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.registered).toBe(2);
    expect(res.body.results).toEqual([
      { botName: 'feishu-alpha', status: 201 },
      { botName: 'telegram-beta', status: 201 },
      { botName: 'bad-no-url', status: 400, error: 'url_required' },
    ]);
    // Verify with includeHidden (admin) — both registered bots present.
    const list = await call(kit.baseUrl, 'GET', '/api/agents?includeHidden=1', kit.adminToken);
    const names = (list.body.agents as Array<{ botName: string }>).map((a) => a.botName).sort();
    expect(names).toEqual(['feishu-alpha', 'telegram-beta']);
  });

  it('POST /api/agents/bulk → 400 when bots array missing', async () => {
    kit = await startTestServer('agents-bulk-bad');
    const token = await issueMember(kit);
    const res = await call(kit.baseUrl, 'POST', '/api/agents/bulk', token, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bots_array_required');
  });

  it('POST /api/agents/bulk reports name_squat per entry without failing the batch', async () => {
    kit = await startTestServer('agents-bulk-squat');
    const tokenA = await issueMember(kit, 'cred-a');
    const tokenB = await issueMember(kit, 'cred-b');
    await call(kit.baseUrl, 'POST', '/api/agents', tokenA, {
      botName: 'reserved-name', url: 'http://x',
    });
    const res = await call(kit.baseUrl, 'POST', '/api/agents/bulk', tokenB, {
      bots: [
        { botName: 'reserved-name', url: 'http://y' },
        { botName: 'fresh-name', url: 'http://z' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.registered).toBe(1);
    expect(res.body.results).toEqual([
      { botName: 'reserved-name', status: 403, error: 'name_squat' },
      { botName: 'fresh-name', status: 201 },
    ]);
  });

  it('POST /api/agents/heartbeat (legacy single, no body) bumps last_seen_at for cred.botName', async () => {
    kit = await startTestServer('agents-heartbeat');
    const token = await issueMember(kit, 'alice-bot');
    const reg = await call(kit.baseUrl, 'POST', '/api/agents', token, { url: 'http://x' });
    expect(reg.status).toBe(201);
    const t1 = reg.body.lastSeenAt as string;
    await new Promise((r) => setTimeout(r, 5));
    const hb = await call(kit.baseUrl, 'POST', '/api/agents/heartbeat', token, {});
    expect(hb.status).toBe(200);
    expect(hb.body.ok).toBe(true);
    expect(Date.parse(hb.body.lastSeenAt)).toBeGreaterThan(Date.parse(t1));
  });

  it('POST /api/agents/heartbeat → 404 for unregistered caller (legacy single form)', async () => {
    kit = await startTestServer('agents-heartbeat-404');
    const token = await issueMember(kit);
    const hb = await call(kit.baseUrl, 'POST', '/api/agents/heartbeat', token, {});
    expect(hb.status).toBe(404);
    expect(hb.body.error).toBe('agent_not_registered');
  });

  it('POST /api/agents/heartbeat with botNames[] bumps every owned name and skips others', async () => {
    kit = await startTestServer('agents-heartbeat-batch');
    const token = await issueMember(kit, 'bridge-cred');
    await call(kit.baseUrl, 'POST', '/api/agents/bulk', token, {
      bots: [
        { botName: 'feishu-alpha', url: 'http://a' },
        { botName: 'telegram-beta', url: 'http://b' },
      ],
    });
    await new Promise((r) => setTimeout(r, 5));
    const hb = await call(kit.baseUrl, 'POST', '/api/agents/heartbeat', token, {
      botNames: ['feishu-alpha', 'telegram-beta', 'not-mine'],
    });
    expect(hb.status).toBe(200);
    expect(hb.body.ok).toBe(true);
    expect(Object.keys(hb.body.bumped).sort()).toEqual(['feishu-alpha', 'telegram-beta']);
  });

  it('GET /api/agents returns visible-only by default', async () => {
    kit = await startTestServer('agents-list-visible');
    const tokenA = await issueMember(kit, 'alice-bot');
    const tokenB = await issueMember(kit, 'bob-bot');
    await call(kit.baseUrl, 'POST', '/api/agents', tokenA, { url: 'http://a' });
    await call(kit.baseUrl, 'POST', '/api/agents', tokenB, { url: 'http://b', visible: false });
    const list = await call(kit.baseUrl, 'GET', '/api/agents', tokenA);
    expect(list.status).toBe(200);
    const names = (list.body.agents as Array<{ botName: string }>).map((a) => a.botName).sort();
    expect(names).toEqual(['alice-bot']);
    // No talkSecret in the response shape.
    expect((list.body.agents as Array<Record<string, unknown>>)[0].talkSecret).toBeUndefined();
  });

  it('GET /api/agents — owner sees own visible:false bot via a different-machine cred (same ownerName)', async () => {
    kit = await startTestServer('agents-list-owner-bypass');
    // Same human, two different machines. Same `ownerName`, different
    // `botName`s. Without owner-bypass, the visible:1 SQL pre-filter would
    // have hidden machine-1's invisible bot from machine-2's cred.
    const tokenM1 = await issueMemberWithOwner(kit, 'alice-machine-1', 'alice');
    const tokenM2 = await issueMemberWithOwner(kit, 'alice-machine-2', 'alice');
    const reg = await call(kit.baseUrl, 'POST', '/api/agents', tokenM1, {
      botName: 'hidden-bot', url: 'http://m1:9100', visible: false,
    });
    expect(reg.status).toBe(201);
    const list = await call(kit.baseUrl, 'GET', '/api/agents', tokenM2);
    expect(list.status).toBe(200);
    const names = (list.body.agents as Array<{ botName: string }>).map((a) => a.botName);
    expect(names).toContain('hidden-bot');
  });

  it('GET /api/agents — non-owner does NOT see another user\'s visible:false bot', async () => {
    kit = await startTestServer('agents-list-cross-owner-hidden');
    const aliceTok = await issueMemberWithOwner(kit, 'alice-bot', 'alice');
    const bobTok = await issueMemberWithOwner(kit, 'bob-bot', 'bob');
    await call(kit.baseUrl, 'POST', '/api/agents', aliceTok, {
      botName: 'alice-secret', url: 'http://x:9100', visible: false,
    });
    const list = await call(kit.baseUrl, 'GET', '/api/agents', bobTok);
    expect(list.status).toBe(200);
    const names = (list.body.agents as Array<{ botName: string }>).map((a) => a.botName);
    expect(names).not.toContain('alice-secret');
  });

  it('PATCH /api/agents/:botName/visible-to-owners — allowlisted user sees hidden bot, others don\'t', async () => {
    kit = await startTestServer('agents-allowlist-share');
    const aliceTok = await issueMemberWithOwner(kit, 'alice-bot', 'alice');
    const bobTok = await issueMemberWithOwner(kit, 'bob-bot', 'bob');
    const carolTok = await issueMemberWithOwner(kit, 'carol-bot', 'carol');
    await call(kit.baseUrl, 'POST', '/api/agents', aliceTok, {
      botName: 'alice-hidden', url: 'http://a:9100', visible: false,
    });
    // Initially bob can't see it.
    const before = await call(kit.baseUrl, 'GET', '/api/agents', bobTok);
    expect((before.body.agents as Array<{ botName: string }>).map((a) => a.botName))
      .not.toContain('alice-hidden');
    // Alice shares with bob.
    const share = await call(
      kit.baseUrl, 'PATCH', '/api/agents/alice-hidden/visible-to-owners', aliceTok,
      { owners: ['bob'] },
    );
    expect(share.status).toBe(200);
    expect(share.body).toEqual({ botName: 'alice-hidden', visibleToOwners: ['bob'] });
    // Bob can now see it.
    const bobList = await call(kit.baseUrl, 'GET', '/api/agents', bobTok);
    const bobNames = (bobList.body.agents as Array<{ botName: string }>).map((a) => a.botName);
    expect(bobNames).toContain('alice-hidden');
    // Carol still can't.
    const carolList = await call(kit.baseUrl, 'GET', '/api/agents', carolTok);
    const carolNames = (carolList.body.agents as Array<{ botName: string }>).map((a) => a.botName);
    expect(carolNames).not.toContain('alice-hidden');
  });

  it('PATCH /api/agents/:botName/visible-to-owners by another member → 403', async () => {
    kit = await startTestServer('agents-allowlist-other-member');
    const aliceTok = await issueMemberWithOwner(kit, 'alice-bot', 'alice');
    const bobTok = await issueMemberWithOwner(kit, 'bob-bot', 'bob');
    await call(kit.baseUrl, 'POST', '/api/agents', aliceTok, {
      botName: 'alice-bot', url: 'http://a:9100',
    });
    const res = await call(
      kit.baseUrl, 'PATCH', '/api/agents/alice-bot/visible-to-owners', bobTok,
      { owners: ['carol'] },
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('agent_ownership_required');
  });

  it('PATCH /api/agents/:botName/visible-to-owners by admin → 200', async () => {
    kit = await startTestServer('agents-allowlist-admin');
    const aliceTok = await issueMemberWithOwner(kit, 'alice-bot', 'alice');
    await call(kit.baseUrl, 'POST', '/api/agents', aliceTok, {
      botName: 'alice-bot', url: 'http://a:9100', visible: false,
    });
    const res = await call(
      kit.baseUrl, 'PATCH', '/api/agents/alice-bot/visible-to-owners', kit.adminToken,
      { owners: ['external'] },
    );
    expect(res.status).toBe(200);
    expect(res.body.visibleToOwners).toEqual(['external']);
  });

  it('PATCH /api/agents/:botName/visible-to-owners → 400 when owners not an array', async () => {
    kit = await startTestServer('agents-allowlist-bad-body');
    const aliceTok = await issueMemberWithOwner(kit, 'alice-bot', 'alice');
    await call(kit.baseUrl, 'POST', '/api/agents', aliceTok, {
      botName: 'alice-bot', url: 'http://a:9100',
    });
    const res = await call(
      kit.baseUrl, 'PATCH', '/api/agents/alice-bot/visible-to-owners', aliceTok,
      { owners: 'bob' },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('owners_required');
  });

  it('PATCH /api/agents/:botName/visible-to-owners de-dups and trims', async () => {
    kit = await startTestServer('agents-allowlist-dedup');
    const aliceTok = await issueMemberWithOwner(kit, 'alice-bot', 'alice');
    await call(kit.baseUrl, 'POST', '/api/agents', aliceTok, {
      botName: 'alice-bot', url: 'http://a:9100', visible: false,
    });
    const res = await call(
      kit.baseUrl, 'PATCH', '/api/agents/alice-bot/visible-to-owners', aliceTok,
      { owners: ['bob', '  bob  ', 'carol', '', 'bob'] },
    );
    expect(res.status).toBe(200);
    expect(res.body.visibleToOwners).toEqual(['bob', 'carol']);
  });

  it('PATCH /api/agents/:botName/visible-to-owners → 404 when bot not registered', async () => {
    kit = await startTestServer('agents-allowlist-404');
    const aliceTok = await issueMemberWithOwner(kit, 'alice-bot', 'alice');
    const res = await call(
      kit.baseUrl, 'PATCH', '/api/agents/nonexistent/visible-to-owners', aliceTok,
      { owners: ['bob'] },
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('agent_not_found');
  });

  it('GET /api/agents — allowlist is ignored when bot is public (visible:true)', async () => {
    kit = await startTestServer('agents-allowlist-noop-when-public');
    const aliceTok = await issueMemberWithOwner(kit, 'alice-bot', 'alice');
    const bobTok = await issueMemberWithOwner(kit, 'bob-bot', 'bob');
    // Bot is public AND has an empty allowlist — bob should see it because
    // it's public, not because of the allowlist.
    await call(kit.baseUrl, 'POST', '/api/agents', aliceTok, {
      botName: 'alice-public', url: 'http://a:9100', visible: true,
    });
    const list = await call(kit.baseUrl, 'GET', '/api/agents', bobTok);
    const names = (list.body.agents as Array<{ botName: string }>).map((a) => a.botName);
    expect(names).toContain('alice-public');
  });

  it('GET /api/agents derives host from url for each agent (different hosts → different host fields)', async () => {
    kit = await startTestServer('agents-list-host-derived');
    const tokenA = await issueMember(kit, 'alice-bot');
    const tokenB = await issueMember(kit, 'bob-bot');
    await call(kit.baseUrl, 'POST', '/api/agents', tokenA, { url: 'http://172.31.32.2:9100' });
    await call(kit.baseUrl, 'POST', '/api/agents', tokenB, { url: 'http://localhost:9100' });
    const list = await call(kit.baseUrl, 'GET', '/api/agents', tokenA);
    expect(list.status).toBe(200);
    const byName: Record<string, string> = {};
    for (const a of list.body.agents as Array<{ botName: string; host: string }>) {
      byName[a.botName] = a.host;
    }
    expect(byName['alice-bot']).toBe('172.31.32.2');
    expect(byName['bob-bot']).toBe('localhost');
  });

  it('GET /api/agents falls back to raw url when hostname is unparseable (no 500)', async () => {
    kit = await startTestServer('agents-list-host-fallback');
    const token = await issueMember(kit, 'malformed-bot');
    // `not a url` is not a valid absolute URL → new URL() throws → fall back
    // to the raw string. Stored verbatim; no schema validation rejects it.
    await call(kit.baseUrl, 'POST', '/api/agents', token, { url: 'not a url' });
    const list = await call(kit.baseUrl, 'GET', '/api/agents', token);
    expect(list.status).toBe(200);
    const rec = (list.body.agents as Array<{ botName: string; host: string; url: string }>)
      .find((a) => a.botName === 'malformed-bot');
    expect(rec).toBeDefined();
    expect(rec!.host).toBe('not a url');
    expect(rec!.url).toBe('not a url');
  });

  it('GET /api/agents?includeHidden=1 by admin returns hidden + visible', async () => {
    kit = await startTestServer('agents-list-admin-incl-hidden');
    const tokenA = await issueMember(kit, 'alice-bot');
    const tokenB = await issueMember(kit, 'bob-bot');
    await call(kit.baseUrl, 'POST', '/api/agents', tokenA, { url: 'http://a' });
    await call(kit.baseUrl, 'POST', '/api/agents', tokenB, { url: 'http://b', visible: false });
    const list = await call(kit.baseUrl, 'GET', '/api/agents?includeHidden=1', kit.adminToken);
    expect(list.status).toBe(200);
    const names = (list.body.agents as Array<{ botName: string }>).map((a) => a.botName).sort();
    expect(names).toEqual(['alice-bot', 'bob-bot']);
  });

  it('GET /api/agents?includeHidden=1 by member → 403', async () => {
    kit = await startTestServer('agents-list-member-incl-hidden-forbidden');
    const token = await issueMember(kit);
    const res = await call(kit.baseUrl, 'GET', '/api/agents?includeHidden=1', token);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('include_hidden_admin_only');
  });

  it('PATCH /api/agents/:botName/visibility by owner → 200', async () => {
    kit = await startTestServer('agents-visibility-owner');
    const token = await issueMember(kit, 'alice-bot');
    await call(kit.baseUrl, 'POST', '/api/agents', token, { url: 'http://a' });
    const res = await call(kit.baseUrl, 'PATCH', '/api/agents/alice-bot/visibility', token, { visible: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ botName: 'alice-bot', visible: false });
  });

  it('PATCH /api/agents/:botName/visibility by another member → 403', async () => {
    kit = await startTestServer('agents-visibility-other-member');
    const tokenA = await issueMember(kit, 'alice-bot');
    const tokenB = await issueMember(kit, 'bob-bot');
    await call(kit.baseUrl, 'POST', '/api/agents', tokenA, { url: 'http://a' });
    const res = await call(kit.baseUrl, 'PATCH', '/api/agents/alice-bot/visibility', tokenB, { visible: false });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('agent_ownership_required');
  });

  it('PATCH /api/agents/:botName/visibility by admin → 200', async () => {
    kit = await startTestServer('agents-visibility-admin');
    const token = await issueMember(kit, 'alice-bot');
    await call(kit.baseUrl, 'POST', '/api/agents', token, { url: 'http://a' });
    const res = await call(kit.baseUrl, 'PATCH', '/api/agents/alice-bot/visibility', kit.adminToken, { visible: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ botName: 'alice-bot', visible: false });
  });

  it('DELETE /api/agents/:botName has same ownership semantics as PATCH', async () => {
    kit = await startTestServer('agents-delete-ownership');
    const tokenA = await issueMember(kit, 'alice-bot');
    const tokenB = await issueMember(kit, 'bob-bot');
    await call(kit.baseUrl, 'POST', '/api/agents', tokenA, { url: 'http://a' });
    const cross = await call(kit.baseUrl, 'DELETE', '/api/agents/alice-bot', tokenB);
    expect(cross.status).toBe(403);
    expect(cross.body.error).toBe('agent_ownership_required');
    const owner = await call(kit.baseUrl, 'DELETE', '/api/agents/alice-bot', tokenA);
    expect(owner.status).toBe(200);
    expect(owner.body).toEqual({ botName: 'alice-bot', removed: true });
    const adminMissing = await call(kit.baseUrl, 'DELETE', '/api/agents/alice-bot', kit.adminToken);
    expect(adminMissing.status).toBe(404);
  });

  it('GET /api/whoami returns the caller credential identity for Bearer', async () => {
    kit = await startTestServer('whoami-bearer');
    const token = await issueMember(kit, 'alice-bot');
    const res = await call(kit.baseUrl, 'GET', '/api/whoami', token);
    expect(res.status).toBe(200);
    expect(res.body.botName).toBe('alice-bot');
    expect(res.body.role).toBe('member');
    expect(res.body.authSource).toBe('bearer');
    expect(typeof res.body.credentialId).toBe('string');
  });

  it('GET /api/whoami without auth → 401', async () => {
    kit = await startTestServer('whoami-no-auth');
    const res = await call(kit.baseUrl, 'GET', '/api/whoami', null);
    expect(res.status).toBe(401);
  });

  it('audit log records register/heartbeat/list/visibility/delete/whoami with correct ops', async () => {
    kit = await startTestServer('agents-audit');
    const token = await issueMember(kit, 'alice-bot');
    await call(kit.baseUrl, 'POST', '/api/agents', token, { url: 'http://a' });
    await call(kit.baseUrl, 'POST', '/api/agents/bulk', token, { bots: [] });
    await call(kit.baseUrl, 'POST', '/api/agents/heartbeat', token, {});
    await call(kit.baseUrl, 'GET', '/api/agents', token);
    await call(kit.baseUrl, 'GET', '/api/whoami', token);
    await call(kit.baseUrl, 'PATCH', '/api/agents/alice-bot/visibility', token, { visible: false });
    await call(kit.baseUrl, 'DELETE', '/api/agents/alice-bot', token);

    await new Promise((r) => setTimeout(r, 100));
    const auditDir = path.join(kit.dir, 'audit');
    const files = fs.readdirSync(auditDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    const raw = fs.readFileSync(path.join(auditDir, files[0]), 'utf-8');
    const entries = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const found = (op: string, p: string) =>
      entries.some((e) => e.op === op && e.path === p);
    expect(found('register', '/api/agents')).toBe(true);
    expect(found('register', '/api/agents/bulk')).toBe(true);
    expect(found('heartbeat', '/api/agents/heartbeat')).toBe(true);
    expect(found('list', '/api/agents')).toBe(true);
    expect(found('whoami', '/api/whoami')).toBe(true);
    expect(found('visibility', '/api/agents/alice-bot/visibility')).toBe(true);
    expect(found('delete', '/api/agents/alice-bot')).toBe(true);
  });

  it('PATCH /api/agents/:botName/memory-visibility toggles memoryPublic; whoami reflects it', async () => {
    kit = await startTestServer('agents-memory-visibility');
    const token = await issueMember(kit, 'mv-bot');
    await call(kit.baseUrl, 'POST', '/api/agents', token, { url: 'http://x:9100' });

    // Default — whoami should show memoryPublic:true (public-by-default)
    const before = await call(kit.baseUrl, 'GET', '/api/whoami', token);
    expect(before.status).toBe(200);
    expect(before.body.memoryPublic).toBe(true);

    // Flip off
    const flip = await call(
      kit.baseUrl, 'PATCH', '/api/agents/mv-bot/memory-visibility', token, { memoryPublic: false },
    );
    expect(flip.status).toBe(200);
    expect(flip.body.memoryPublic).toBe(false);

    // whoami now reports false
    const after = await call(kit.baseUrl, 'GET', '/api/whoami', token);
    expect(after.body.memoryPublic).toBe(false);

    // /api/agents list surfaces it too
    const list = await call(kit.baseUrl, 'GET', '/api/agents', token);
    const row = (list.body.agents as Array<{ botName: string; memoryPublic: boolean }>).find(
      (a) => a.botName === 'mv-bot',
    );
    expect(row?.memoryPublic).toBe(false);

    // Flipping with bad body → 400
    const bad = await call(
      kit.baseUrl, 'PATCH', '/api/agents/mv-bot/memory-visibility', token, { memoryPublic: 'yes' },
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('memory_public_required');
  });

  it('PATCH /api/agents/:botName/memory-visibility → 403 when a different cred owns the row', async () => {
    kit = await startTestServer('agents-memory-vis-403');
    const tokenA = await issueMember(kit, 'cred-a');
    const tokenB = await issueMember(kit, 'cred-b');
    await call(kit.baseUrl, 'POST', '/api/agents', tokenA, {
      botName: 'shared-name', url: 'http://a',
    });
    const res = await call(
      kit.baseUrl, 'PATCH', '/api/agents/shared-name/memory-visibility', tokenB, { memoryPublic: true },
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('agent_ownership_required');
  });

  it('bulk-register accepts memoryPublic; omitting it on re-register preserves the runtime toggle', async () => {
    kit = await startTestServer('agents-bulk-memory-public');
    const token = await issueMember(kit, 'bridge-cred');
    // First bulk register WITH memoryPublic:false on one bot; beta omits = default true
    await call(kit.baseUrl, 'POST', '/api/agents/bulk', token, {
      bots: [
        { botName: 'alpha', url: 'http://a:9100', memoryPublic: false },
        { botName: 'beta',  url: 'http://b:9100' },
      ],
    });
    const list1 = await call(kit.baseUrl, 'GET', '/api/agents', token);
    const alpha1 = (list1.body.agents as Array<{ botName: string; memoryPublic: boolean }>).find(
      (a) => a.botName === 'alpha',
    );
    const beta1 = (list1.body.agents as Array<{ botName: string; memoryPublic: boolean }>).find(
      (a) => a.botName === 'beta',
    );
    expect(alpha1?.memoryPublic).toBe(false);
    expect(beta1?.memoryPublic).toBe(true);

    // Re-register WITHOUT memoryPublic on alpha → should keep false (sticky)
    await call(kit.baseUrl, 'POST', '/api/agents/bulk', token, {
      bots: [
        { botName: 'alpha', url: 'http://a:9100' },
      ],
    });
    const list2 = await call(kit.baseUrl, 'GET', '/api/agents', token);
    const alpha2 = (list2.body.agents as Array<{ botName: string; memoryPublic: boolean }>).find(
      (a) => a.botName === 'alpha',
    );
    expect(alpha2?.memoryPublic).toBe(false);
  });
});
