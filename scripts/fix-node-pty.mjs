#!/usr/bin/env node
// node-pty's own post-install only chmods its node-gyp output (build/Release);
// when the PREBUILD path is used, npm's tarball extraction strips the exec bit
// from prebuilds/*/spawn-helper and nothing restores it — macOS pty.spawn then
// dies with a bare "posix_spawnp failed." (bit us on a fresh Mac mini).
// Idempotent, silent when node-pty or the files are absent.
import { chmodSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty', 'prebuilds');
try {
  for (const platform of readdirSync(root)) {
    const helper = join(root, platform, 'spawn-helper');
    try {
      const st = statSync(helper);
      if ((st.mode & 0o111) === 0) {
        chmodSync(helper, 0o755);
        console.log(`[fix-node-pty] +x ${platform}/spawn-helper`);
      }
    } catch { /* platform without spawn-helper */ }
  }
} catch { /* node-pty absent — nothing to fix */ }
