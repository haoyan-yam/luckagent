import { describe, it, expect, afterEach } from 'vitest';
import { makeKit, type TestKit } from './helpers.js';
import type { Credential } from '../src/auth/credentials.js';
import { slugify } from '../src/memory/memory-store.js';

let kit: TestKit | undefined;

afterEach(() => {
  kit?.cleanup();
  kit = undefined;
});

function issue(kit: TestKit, name: string, role: 'admin' | 'member', overrides: Partial<Credential> = {}): Credential {
  const { credential } = kit.credentials.issue({
    botName: name, ownerName: name, role,
  });
  const full = kit.credentials.findById(credential.id)!;
  return { ...full, ...overrides };
}

describe('MemoryStore + ACL', () => {
  it('admin can write anywhere; member is scoped', () => {
    kit = makeKit('mem-acl');
    const admin = issue(kit, 'admin-a', 'admin');
    const dkj = issue(kit, 'dkj-laptop', 'member');

    // Admin creates /shared/skills folder
    const shared = kit.memory.createFolder({ name: 'shared', parent_id: 'root' }, admin);
    kit.memory.createFolder({ path: '/shared/skills' }, admin);

    // Member writes within their own namespace via path-based create
    const doc = kit.memory.createDocument({
      title: 'My Note',
      path: '/users/dkj-laptop/private/notes/my-note',
      content: '# hello',
    }, dkj);
    expect(doc.path).toBe('/users/dkj-laptop/private/notes/my-note');

    // Member cannot write to /shared
    expect(() => kit!.memory.createDocument({
      title: 'pwn',
      path: '/shared/skills/evil',
      content: 'x',
    }, dkj)).toThrow();

    // Member cannot write to another user's ns
    expect(() => kit!.memory.createDocument({
      title: 'snoop',
      path: '/users/alicew/private/secrets/y',
      content: 'x',
    }, dkj)).toThrow();

    // Admin can read member's doc
    const adminRead = kit.memory.getDocument(doc.path, admin);
    expect(adminRead?.id).toBe(doc.id);

    // Member can read /shared
    const sharedRead = kit.memory.findFolderByPath('/shared');
    expect(sharedRead).toBeTruthy();
    expect(shared.id).toBeTruthy();
    const sharedList = kit.memory.listFolders('/shared', dkj);
    expect(sharedList.some((f) => f.path === '/shared')).toBe(true);
  });

  it('member cannot read another user namespace', () => {
    kit = makeKit('mem-isolation');
    const admin = issue(kit, 'admin', 'admin');
    const a = issue(kit, 'bot-a', 'member');
    const b = issue(kit, 'bot-b', 'member');

    const docA = kit.memory.createDocument({
      title: 'note', path: '/users/bot-a/private/note', content: 'secret',
    }, a);

    // b can't get a's doc by path
    expect(kit.memory.getDocument(docA.path, b)).toBeNull();
    // admin can
    expect(kit.memory.getDocument(docA.path, admin)?.id).toBe(docA.id);
  });

  it('search results are ACL-filtered', () => {
    kit = makeKit('mem-search');
    const admin = issue(kit, 'admin', 'admin');
    const a = issue(kit, 'bot-a', 'member');
    const b = issue(kit, 'bot-b', 'member');

    kit.memory.createDocument({
      title: 'alpha', path: '/users/bot-a/projects/x/alpha', content: 'lookmeup unique-token',
    }, a);
    kit.memory.createDocument({
      title: 'beta',  path: '/shared/notes/beta',
      content: 'lookmeup public',
    }, admin);

    const adminResults = kit.memory.searchDocuments('lookmeup', 20, admin);
    expect(adminResults.length).toBe(2);

    const bResults = kit.memory.searchDocuments('lookmeup', 20, b);
    // b can only see /shared, not /users/bot-a
    expect(bResults.length).toBe(1);
    expect(bResults[0].path.startsWith('/shared/')).toBe(true);
  });

  it('deleteFolder cascades + enforces ACL', () => {
    kit = makeKit('mem-delete');
    const admin = issue(kit, 'admin', 'admin');
    const a = issue(kit, 'bot-a', 'member');

    kit.memory.createDocument({
      title: 'one', path: '/users/bot-a/projects/x/one', content: '1',
    }, a);
    kit.memory.createDocument({
      title: 'two', path: '/users/bot-a/projects/x/two', content: '2',
    }, a);

    const folder = kit.memory.findFolderByPath('/users/bot-a/projects/x')!;
    // member can delete their own folder
    kit.memory.deleteFolder(folder.path, a);

    // gone
    expect(kit.memory.findFolderByPath('/users/bot-a/projects/x')).toBeNull();
    expect(kit.memory.listDocuments({ prefix: '/users/bot-a/projects/x' }, admin).length).toBe(0);
  });

  it('listFolders applies prefix + ACL', () => {
    kit = makeKit('mem-listfolders');
    const admin = issue(kit, 'admin', 'admin');
    const a = issue(kit, 'bot-a', 'member');

    kit.memory.createDocument({
      title: 'doc', path: '/users/bot-a/projects/proj1/doc', content: '',
    }, a);
    kit.memory.createFolder({ path: '/shared/teamx' }, admin);

    const list = kit.memory.listFolders('/users/bot-a', a);
    for (const f of list) {
      expect(f.path.startsWith('/users/bot-a')).toBe(true);
    }
    // member can't see /shared via /users prefix
    expect(list.some((f) => f.path === '/shared/teamx')).toBe(false);
  });
});

describe('MemoryStore: non-ASCII titles get their own path segment', () => {
  it('slugify keeps Unicode letters and falls back when nothing is sluggable', () => {
    expect(slugify('My Note')).toBe('my-note');
    expect(slugify('项目决策：第3次')).toBe('项目决策-第3次');
    expect(slugify('!!!', 'untitled-x')).toBe('untitled-x');
  });

  it('two Chinese-titled docs in one folder get distinct paths (no 409, no folder-path collapse)', () => {
    kit = makeKit('mem-cjk');
    const me = issue(kit, 'cjk-bot', 'member');
    const folder = kit.memory.createFolder({ path: '/users/cjk-bot/notes' }, me);
    const a = kit.memory.createDocument({ title: '项目决策记录', folder_id: folder.id, content: 'a' }, me);
    const b = kit.memory.createDocument({ title: '会议纪要', folder_id: folder.id, content: 'b' }, me);
    expect(a.path).toBe('/users/cjk-bot/notes/项目决策记录');
    expect(b.path).toBe('/users/cjk-bot/notes/会议纪要');
    expect(kit.memory.getDocument('/users/cjk-bot/notes/会议纪要', me)?.id).toBe(b.id);
  });

  it('emoji-only titles still get a unique path', () => {
    kit = makeKit('mem-emoji');
    const me = issue(kit, 'emo-bot', 'member');
    const folder = kit.memory.createFolder({ path: '/users/emo-bot/notes' }, me);
    const a = kit.memory.createDocument({ title: '🎉', folder_id: folder.id, content: 'a' }, me);
    const b = kit.memory.createDocument({ title: '🎉', folder_id: folder.id, content: 'b' }, me);
    expect(a.path).not.toBe(b.path);
    expect(a.path.startsWith('/users/emo-bot/notes/untitled-')).toBe(true);
  });

  it('renaming to a Chinese title moves the doc to that segment', () => {
    kit = makeKit('mem-cjk-rename');
    const me = issue(kit, 'cjk-bot', 'member');
    const folder = kit.memory.createFolder({ path: '/users/cjk-bot/notes' }, me);
    const doc = kit.memory.createDocument({ title: 'draft', folder_id: folder.id, content: 'x' }, me);
    const renamed = kit.memory.updateDocument(doc.id, { title: '正式方案' }, me);
    expect(renamed?.path).toBe('/users/cjk-bot/notes/正式方案');
  });
});
