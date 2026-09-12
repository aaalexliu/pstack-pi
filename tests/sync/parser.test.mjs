import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLock, parseManifest } from '../../scripts/sync-upstream.mjs';
import { fixture } from './fixture.mjs';

test('manifest and lock accept strict versioned fixture data', async (t) => {
  const { manifest, lock } = await fixture(t);
  assert.deepEqual(parseManifest(JSON.parse(JSON.stringify(manifest))), manifest);
  assert.deepEqual(parseLock(JSON.parse(JSON.stringify(lock))), lock);
});

test('manifest rejects unknown fields and illegal dispositions', async (t) => {
  const { manifest } = await fixture(t);
  for (const file of [
    { kind: 'copy', source: 'x', destination: 'skills/shared/x', transforms: [] },
    { kind: 'omit', source: 'x', destination: 'skills/shared/x', reason: 'Not used by Pi.' },
    { kind: 'replace', source: 'x', destination: 'skills/shared/x', replacement: 'x', reason: 'Use Pi policy.' },
    { kind: 'transform', source: 'x', destination: 'skills/shared/x', expectedBlob: 'a'.repeat(40), transforms: [], reason: 'Use Pi names.' },
    { kind: 'patch', source: 'x', destination: 'skills/shared/x' },
  ]) assert.throws(() => parseManifest({ ...manifest, files: [file] }));
  assert.throws(() => parseManifest({ ...manifest, version: 1 }));
  assert.throws(() => parseManifest({ ...manifest, extra: true }));
  assert.throws(() => parseManifest({ ...manifest, files: [] }));
  assert.throws(() => parseManifest({ ...manifest, managedRoots: ['extensions'] }));
});

test('manifest requires a nonempty review reason only for adapted and omitted sources', async (t) => {
  const { manifest } = await fixture(t);
  for (const file of manifest.files) {
    /** @param {unknown} candidate */
    const parse = (candidate) => parseManifest({ ...manifest, files: [candidate] });
    assert.doesNotThrow(() => parse(file));
    if (file.kind === 'copy') {
      for (const reason of ['Unneeded reason.', '', undefined]) {
        assert.throws(() => parse({ ...file, reason }), /Expected fields/u);
      }
      continue;
    }
    const { reason, ...withoutReason } = file;
    assert.throws(() => parse(withoutReason), /Expected fields/u, file.kind);
    for (const invalid of ['', ' \t\r\n', null, undefined, false, 1, [], {}]) {
      assert.throws(() => parse({ ...file, reason: invalid }), /nonempty review reason/u, file.kind);
    }
    assert.throws(() => parse({ ...withoutReason, rationale: reason }), /Expected fields/u, file.kind);
    assert.throws(() => parse({ ...file, rationale: reason }), /Expected fields/u, file.kind);
  }
});

test('manifest rejects duplicate and native-colliding sources, outputs, and roots', async (t) => {
  const { manifest } = await fixture(t);
  for (const [first, second] of [
    ['a', 'a'], ['A', 'a'], ['é', 'e\u0301'], ['dir/A', 'Dir/B'], ['a', 'a/b'], ['a/b', 'a'],
  ]) {
    const files = [
      { kind: 'copy', source: first, destination: 'skills/shared/a' },
      { kind: 'copy', source: second, destination: 'skills/shared/b' },
    ];
    assert.throws(() => parseManifest({ ...manifest, files }), /collision/u);
    assert.throws(() => parseManifest({ ...manifest, files: files.map((file, i) => ({ ...file, source: `${i}`, destination: `skills/shared/${file.source}` })) }), /collision/u);
  }
  assert.throws(() => parseManifest({ ...manifest, managedRoots: ['skills', 'skills/shared'] }), /collision/u);
});

test('manifest rejects unsafe paths at every path boundary', async (t) => {
  const { manifest } = await fixture(t);
  for (const bad of ['/tmp/x', '../x', 'a/../x', 'a/./x', 'a//x', 'a\\x', 'C:/x', 'a\0x', 'a\nx', 'a.', 'a ', '.git/x', 'CON.txt', 'a/', 'a*', 'a?', 'a"', 'a<', 'a>', 'a|']) {
    assert.throws(() => parseManifest({ ...manifest, sourceRoot: bad }), /path/iu, bad);
    assert.throws(() => parseManifest({ ...manifest, files: [{ kind: 'omit', source: bad, reason: 'Not used by Pi.' }] }), /path/iu, bad);
    assert.throws(() => parseManifest({ ...manifest, files: [{ kind: 'copy', source: 'x', destination: bad }] }), /path/iu, bad);
    assert.throws(() => parseManifest({ ...manifest, files: [{ kind: 'replace', source: 'x', destination: 'skills/shared/x', expectedBlob: 'a'.repeat(40), replacement: bad, reason: 'Use Pi policy.' }] }), /path/iu, bad);
  }
});

test('lock rejects unknown fields, abbreviated hashes, invalid modes, and collisions', async (t) => {
  const { lock } = await fixture(t);
  assert.throws(() => parseLock({ ...lock, extra: true }));
  assert.throws(() => parseLock({ ...lock, commit: 'HEAD' }));
  assert.throws(() => parseLock({ ...lock, sourceTree: 'abc123' }));
  assert.throws(() => parseLock({ ...lock, repository: '/local/path' }));
  assert.throws(() => parseLock({ ...lock, files: [...lock.files, lock.files[0]] }), /collision/u);
  for (const patch of [{ mode: '120000' }, { blob: 'short' }, { adaptationSha256: 'short' }, { extra: true }, { output: { destination: '../x', mode: '100644', sha256: 'a'.repeat(64) } }]) {
    assert.throws(() => parseLock({ ...lock, files: [{ ...lock.files[0], ...patch }] }));
  }
});
