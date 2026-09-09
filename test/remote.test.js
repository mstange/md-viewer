/**
 * Tests for recognising a remote target.
 *
 *   node --test
 *
 * This is the part where a mistake is expensive in both directions: reading
 * `host:path` as a local file sends the user to a confusing "no such file",
 * and reading a local path as `host:path` sends them to a hung ssh. The cases
 * below are the ambiguous spellings, not the obvious ones.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRemoteTarget } from '../lib/remote.js';

test('a host and a path are split apart', () => {
  assert.deepEqual(parseRemoteTarget('m4:/Volumes/build/overview.md'), {
    user: undefined,
    host: 'm4',
    hostSpec: 'm4',
    file: '/Volumes/build/overview.md',
  });
});

test('a user is kept with the host, not with the path', () => {
  const target = parseRemoteTarget('florian@build.example.com:notes/plan.md');
  assert.equal(target.user, 'florian');
  assert.equal(target.host, 'build.example.com');
  assert.equal(target.hostSpec, 'florian@build.example.com');
  assert.equal(target.file, 'notes/plan.md');
});

test('a path is left alone when it has no host in front of it', () => {
  for (const local of [
    'README.md',
    './notes.md',
    '../up/notes.md',
    '/absolute/notes.md',
    '~/notes.md',
    '-',
  ]) {
    assert.equal(parseRemoteTarget(local), null, local);
  }
});

test('a colon inside a local path is not a host separator', () => {
  // The part before the colon has to look like a hostname, which rules these
  // out: a directory named for a time, a Windows drive, a URL scheme.
  for (const local of [
    'notes/12:30 standup.md',
    '/tmp/a:b/notes.md',
    'C:\\Users\\florian\\notes.md',
    'https://example.com/notes.md',
  ]) {
    assert.equal(parseRemoteTarget(local), null, local);
  }
});

test('a host with no path is not a target', () => {
  // `md-viewer m4:` names no document; treating it as one would send an empty
  // path to the remote and hang there instead of failing here.
  assert.equal(parseRemoteTarget('m4:'), null);
});

test('a relative remote path stays relative', () => {
  // Resolved by the remote shell against the remote home directory, which is
  // what `scp host:notes.md` does too.
  assert.equal(parseRemoteTarget('m4:notes.md').file, 'notes.md');
});
