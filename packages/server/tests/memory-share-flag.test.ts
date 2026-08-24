import { describe, it, expect, afterEach } from 'vitest';
import { makeKit, type TestKit } from './helpers.js';
import { canReadDoc, type Credential } from '../src/auth/credentials.js';
import * as memoryRoutes from '../src/memory/memory-routes.js';

let kit: TestKit | undefined;

afterEach(() => {
  kit?.cleanup();
  kit = undefined;
});

function issue(kit: TestKit, name: string, role: 'admin' | 'member'): Credential {
  const { credential } = kit.credentials.issue({ botName: name, ownerName: name, role });
  return kit.credentials.findById(credential.id)!;
}

function makeCred(overrides: Partial<Credential> = {}): Credential {
  return {
    id: 'cred-id', tokenHash: 'hash', botName: 'cli-bot', ownerName: 'alice',
    role: 'member', writableNamespaces: ['/users/cli-bot'],
    readableNamespaces: ['/shared', '/users/cli-bot'],
    publishSkill: false, createdAt: 0, revokedAt: null, lastUsedAt: null, notes: '',
    ...overrides,
  };
}

describe('canReadDoc: doc-level share flag', () => {
  it('shared=true → readable regardless of path (cross-namespace)', () => {
    const cred = makeCred({ botName: 'bob', ownerName: 'bob' });
    // bob can't read alice's namespace by path…
    expect(canReadDoc(cred, '/users/alice/agents/x/note', false)).toBe(false);
    // …but a shared doc is readable.
    expect(canReadDoc(cred, '/users/alice/agents/x/note', true)).toBe(true);
  });

  it('shared=false → falls back to path-based canRead', () => {
    const cred = makeCred({ botName: 'alice', ownerName: 'alice' });
    // own namespace readable without share
    expect(canReadDoc(cred, '/users/alice/note', false)).toBe(true);
    // other namespace not readable without share
    expect(canReadDoc(cred, '/users/bob/note', false)).toBe(false);
  });

  it('admin reads anything regardless of share', () => {
    const admin = makeCred({ role: 'admin', ownerName: '' });
    expect(canReadDoc(admin, '/users/anyone/secret', false)).toBe(true);
  });
});

describe('MemoryStore: share flag controls cross-namespace reads', () => {
  it('a shared doc in bot-a ns is readable by bot-b; an unshared one is not', () => {
    kit = makeKit('share-read');
    const a = issue(kit, 'bot-a', 'member');
    const b = issue(kit, 'bot-b', 'member');

    const sharedDoc = kit.memory.createDocument({
      title: 'public note', path: '/users/bot-a/notes/public', content: 'x', shared: true,
    }, a);
    const privateDoc = kit.memory.createDocument({
      title: 'private note', path: '/users/bot-a/notes/private', content: 'y', shared: false,
    }, a);

    expect(sharedDoc.shared).toBe(true);
    expect(privateDoc.shared).toBe(false);

    // bot-b sees the shared one, not the private one
    expect(kit.memory.getDocument(sharedDoc.path, b)?.id).toBe(sharedDoc.id);
    expect(kit.memory.getDocument(privateDoc.path, b)).toBeNull();
    // bot-a (owner) sees both
    expect(kit.memory.getDocument(privateDoc.path, a)?.id).toBe(privateDoc.id);
  });

  it('search surfaces shared docs cross-namespace but hides unshared', () => {
    kit = makeKit('share-search');
    const a = issue(kit, 'bot-a', 'member');
    const b = issue(kit, 'bot-b', 'member');

    kit.memory.createDocument({
      title: 'alpha', path: '/users/bot-a/x/alpha', content: 'zzqunique shared', shared: true,
    }, a);
    kit.memory.createDocument({
      title: 'beta', path: '/users/bot-a/x/beta', content: 'zzqunique hidden', shared: false,
    }, a);

    const results = kit.memory.searchDocuments('zzqunique', 20, b);
    expect(results.length).toBe(1);
    expect(results[0].shared).toBe(true);
    expect(results[0].path).toBe('/users/bot-a/x/alpha');
  });

  it('updateDocument can flip shared on/off', () => {
    kit = makeKit('share-flip');
    const a = issue(kit, 'bot-a', 'member');
    const b = issue(kit, 'bot-b', 'member');

    const doc = kit.memory.createDocument({
      title: 'note', path: '/users/bot-a/n/note', content: 'c', shared: false,
    }, a);
    expect(kit.memory.getDocument(doc.path, b)).toBeNull();

    // owner shares it → now readable by b
    kit.memory.updateDocument(doc.id, { shared: true }, a);
    expect(kit.memory.getDocument(doc.path, b)?.id).toBe(doc.id);

    // un-share again → hidden
    kit.memory.updateDocument(doc.id, { shared: false }, a);
    expect(kit.memory.getDocument(doc.path, b)).toBeNull();
  });

  it('content-only update preserves the existing shared flag', () => {
    kit = makeKit('share-preserve');
    const a = issue(kit, 'bot-a', 'member');
    const doc = kit.memory.createDocument({
      title: 'note', path: '/users/bot-a/n/note', content: 'c', shared: true,
    }, a);
    const updated = kit.memory.updateDocument(doc.id, { content: 'changed' }, a);
    expect(updated?.shared).toBe(true);
  });

  it('member still cannot WRITE outside its own namespace, shared or not', () => {
    kit = makeKit('share-write-guard');
    const b = issue(kit, 'bot-b', 'member');
    expect(() => kit!.memory.createDocument({
      title: 'pwn', path: '/users/bot-a/n/evil', content: 'x', shared: true,
    }, b)).toThrow();
  });
});

describe('createDocument route: default shared from agent memoryPublic', () => {
  function registerAgent(kit: TestKit, cred: Credential, memoryPublic: boolean): void {
    kit.agents.register({
      botName: cred.botName,
      url: 'http://localhost:0',
      memoryPublic,
      ownerCredentialId: cred.id,
      ownerName: cred.ownerName,
    });
  }

  it('public agent → new doc defaults to shared:true', () => {
    kit = makeKit('route-public');
    const a = issue(kit, 'bot-a', 'member');
    registerAgent(kit, a, true);
    const res = memoryRoutes.createDocument(kit.memory, kit.agents, {
      title: 'd', path: '/users/bot-a/n/d', content: 'x',
    }, a);
    expect(res.status).toBe(201);
    expect((res.body as { shared: boolean }).shared).toBe(true);
  });

  it('private agent → new doc defaults to shared:false', () => {
    kit = makeKit('route-private');
    const a = issue(kit, 'bot-a', 'member');
    registerAgent(kit, a, false);
    const res = memoryRoutes.createDocument(kit.memory, kit.agents, {
      title: 'd', path: '/users/bot-a/n/d', content: 'x',
    }, a);
    expect((res.body as { shared: boolean }).shared).toBe(false);
  });

  it('explicit shared in body overrides the agent default', () => {
    kit = makeKit('route-override');
    const a = issue(kit, 'bot-a', 'member');
    registerAgent(kit, a, true); // public default…
    const res = memoryRoutes.createDocument(kit.memory, kit.agents, {
      title: 'd', path: '/users/bot-a/n/d', content: 'x', shared: false, // …but explicitly private
    }, a);
    expect((res.body as { shared: boolean }).shared).toBe(false);
  });

  it('unregistered bot → defaults to private (shared:false)', () => {
    kit = makeKit('route-unregistered');
    const a = issue(kit, 'bot-a', 'member');
    // no registerAgent call
    const res = memoryRoutes.createDocument(kit.memory, kit.agents, {
      title: 'd', path: '/users/bot-a/n/d', content: 'x',
    }, a);
    expect((res.body as { shared: boolean }).shared).toBe(false);
  });
});
