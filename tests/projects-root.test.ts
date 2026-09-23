import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECTS_DIR, defaultWorkDirFor, projectsRoot } from '../src/config.js';

/** LUCKAGENT_PROJECTS_DIR: root under which new bot workspaces are created. */
describe('projectsRoot', () => {
  it('defaults to ~/projects when unset or blank', () => {
    expect(projectsRoot({})).toBe(DEFAULT_PROJECTS_DIR);
    expect(projectsRoot({ LUCKAGENT_PROJECTS_DIR: '   ' })).toBe('~/projects');
  });

  it('returns the configured root, trimmed and without trailing slashes', () => {
    expect(projectsRoot({ LUCKAGENT_PROJECTS_DIR: ' /Volumes/Data/bots/ ' })).toBe('/Volumes/Data/bots');
    expect(projectsRoot({ LUCKAGENT_PROJECTS_DIR: '~/work//' })).toBe('~/work');
  });

  it('keeps a bare root slash rather than collapsing it to empty', () => {
    expect(projectsRoot({ LUCKAGENT_PROJECTS_DIR: '/' })).toBe('/');
  });
});

describe('defaultWorkDirFor', () => {
  it('puts a new bot under the configured root', () => {
    expect(defaultWorkDirFor('sales-bot', { LUCKAGENT_PROJECTS_DIR: '/Volumes/Data/bots' })).toBe(
      '/Volumes/Data/bots/sales-bot',
    );
  });

  it('keeps the portable ~ form by default', () => {
    expect(defaultWorkDirFor('sales-bot', {})).toBe('~/projects/sales-bot');
  });
});
