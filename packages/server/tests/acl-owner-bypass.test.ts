import { describe, it, expect } from 'vitest';
import { canRead, canWrite, selfNamespace, type Credential } from '../src/auth/credentials.js';

function makeCred(overrides: Partial<Credential> = {}): Credential {
  return {
    id: 'cred-id',
    tokenHash: 'hash',
    botName: 'cli-bot',
    ownerName: 'alice',
    role: 'member',
    // Note: NO /users/alice — owner-bypass (read) is what should grant
    // visibility, and selfNamespace is what should grant writes under the
    // bot's own /users/alice/agents/cli-bot/ subtree.
    writableNamespaces: ['/users/cli-bot'],
    readableNamespaces: ['/shared', '/users/cli-bot'],
    publishSkill: false,
    createdAt: 0,
    revokedAt: null,
    lastUsedAt: null,
    notes: '',
    ...overrides,
  };
}

describe('canRead: owner-bypass (unchanged)', () => {
  it('member can read /users/<ownerName>/foo even when readableNamespaces lacks the prefix', () => {
    const cred = makeCred();
    expect(canRead(cred, '/users/alice/notes/2026.md')).toBe(true);
  });

  it('member CANNOT read another user\'s /users/<otherOwner>/foo', () => {
    const cred = makeCred();
    expect(canRead(cred, '/users/bob/notes/2026.md')).toBe(false);
  });

  it('owner can read the bare /users/<ownerName> path (no trailing segment)', () => {
    const cred = makeCred();
    expect(canRead(cred, '/users/alice')).toBe(true);
  });

  it('member can read sibling agent paths under the same owner', () => {
    const cred = makeCred();
    expect(canRead(cred, '/users/alice/agents/other-bot/secret.md')).toBe(true);
  });

  it('member can read user-level docs sitting next to agents/', () => {
    const cred = makeCred();
    expect(canRead(cred, '/users/alice/manual-doc.md')).toBe(true);
  });
});

describe('canWrite: confined to selfNamespace', () => {
  it('agent-kind cred CANNOT write the owner root (sibling agents would clash)', () => {
    const cred = makeCred();
    // botName=cli-bot, ownerName=alice → selfNamespace = /users/alice/agents/cli-bot
    expect(canWrite(cred, '/users/alice/notes/2026.md')).toBe(false);
  });

  it('agent-kind cred CAN write under its own /users/<owner>/agents/<bot>/ subtree', () => {
    const cred = makeCred();
    expect(canWrite(cred, '/users/alice/agents/cli-bot/notes/2026.md')).toBe(true);
  });

  it('agent-kind cred CANNOT write a sibling agent\'s subtree', () => {
    const cred = makeCred();
    expect(canWrite(cred, '/users/alice/agents/other-bot/notes/2026.md')).toBe(false);
  });

  it('user-kind cred (botName === ownerName) writes directly to /users/<email>/', () => {
    const cred = makeCred({ botName: 'alice@xvi.com', ownerName: 'alice@xvi.com' });
    expect(canWrite(cred, '/users/alice@xvi.com/notes.md')).toBe(true);
    expect(canWrite(cred, '/users/alice@xvi.com')).toBe(true);
  });

  it('user-kind cred CANNOT write another user\'s root', () => {
    const cred = makeCred({ botName: 'alice@xvi.com', ownerName: 'alice@xvi.com' });
    expect(canWrite(cred, '/users/bob@xvi.com/notes.md')).toBe(false);
  });

  it('empty ownerName disables both self-namespace AND owner-bypass', () => {
    const cred = makeCred({ ownerName: '' });
    expect(canWrite(cred, '/users//foo')).toBe(false);
    expect(canWrite(cred, '/users/alice/foo')).toBe(false);
  });

  it('admin short-circuit still wins', () => {
    const admin = makeCred({ role: 'admin', ownerName: '' });
    expect(canWrite(admin, '/users/anyone/foo')).toBe(true);
    expect(canRead(admin, '/users/anyone/foo')).toBe(true);
  });

  it('selfNamespace match is exact-segment (no prefix-leak)', () => {
    // botName=alice would prefix-match /users/alicia if we used naive startsWith.
    const cred = makeCred({ botName: 'alice', ownerName: 'alice' });
    // selfNamespace = /users/alice → should NOT cover /users/alicia
    expect(canWrite(cred, '/users/alicia/foo')).toBe(false);
  });

  it('writableNamespaces explicit grant still works alongside selfNamespace', () => {
    const cred = makeCred({ writableNamespaces: ['/projects/special'] });
    expect(canWrite(cred, '/projects/special/notes.md')).toBe(true);
    expect(canWrite(cred, '/users/alice/agents/cli-bot/foo')).toBe(true);
    expect(canWrite(cred, '/projects/other/notes.md')).toBe(false);
  });
});

describe('selfNamespace formula', () => {
  it('user-kind (botName === ownerName) → /users/<ownerName>', () => {
    const cred = makeCred({ botName: 'alice@xvi.com', ownerName: 'alice@xvi.com' });
    expect(selfNamespace(cred)).toBe('/users/alice@xvi.com');
  });

  it('agent-kind (botName !== ownerName) → /users/<owner>/agents/<bot>', () => {
    const cred = makeCred({ botName: 'cli-bot', ownerName: 'alice' });
    expect(selfNamespace(cred)).toBe('/users/alice/agents/cli-bot');
  });

  it('empty ownerName → empty (no accidental blanket grant)', () => {
    const cred = makeCred({ ownerName: '' });
    expect(selfNamespace(cred)).toBe('');
  });
});
