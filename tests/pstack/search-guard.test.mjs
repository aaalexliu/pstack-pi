import assert from 'node:assert/strict';
import test from 'node:test';
import { findHint, grepHint, registerSearchGuard, searchGuardReason } from '../../extensions/pstack/search-guard.ts';

const home = '/Users/someone';
const repo = '/Users/someone/dev/app';

/** @param {string} command @param {string} [cwd] */
const reason = (command, cwd = repo) => searchGuardReason(command, cwd, home);

test('blocks recursive grep without --exclude-dir', () => {
  for (const command of [
    'grep -r foo .',
    'grep -R foo src',
    'grep -rn "needle" tests web',
    'grep -inR needle .',
    'grep --recursive needle .',
    'grep --dereference-recursive needle .',
    'grep -d recurse needle .',
    'grep --directories=recurse needle .',
    'egrep -r "a|b" .',
    '/usr/bin/grep -r foo .',
    'grep -rn foo tests web 2>/dev/null | head -20',
    'cd web && grep -rl foo . | wc -l',
    'LC_ALL=C grep -r foo .',
    'timeout 10 grep -r foo .',
    'xargs -n 1 grep -r foo',
    'bash -lc "grep -r foo ."',
    'echo $(grep -r foo .)',
    'echo `grep -r foo .`',
    'cat <(grep -r foo .)',
    'grep -e bar -r foo .',
    'grep -A3 -r foo .',
    'ls\ngrep -r foo .',
    'grep -r \\\n  foo .',
  ]) assert.equal(reason(command), grepHint, command);
});

test('allows grep that is not an unbounded recursive walk', () => {
  for (const command of [
    'grep -rn foo --exclude-dir=node_modules .',
    'grep -r --exclude-dir node_modules foo .',
    'grep -n foo src/index.ts',
    'grep -e -r file.txt',
    'grep -- -r file.txt',
    'ps aux | grep node',
    'git grep -n foo',
    'rg -n foo',
    'echo "grep -r foo ."',
    "echo 'grep -r foo .'",
    'printf "%s" x > grep-r.txt',
    '# grep -r foo .\nls',
    "cat <<'EOF' > notes.sh\ngrep -r foo .\nfind / -name x\nEOF\nls",
    'cat <<-EOF\n\tgrep -r foo .\n\tEOF',
    'grep --include -r foo file.txt',
  ]) assert.equal(reason(command), undefined, command);
});

test('blocks find rooted at home, root, or a folder above home', () => {
  for (const command of [
    'find ~ -name "*.plist"',
    'find ~/ -name x',
    'find / -name rg 2>/dev/null',
    'find $HOME -name x',
    'find "${HOME}" -type d -name node_modules',
    'find /Users -name x',
    'find /Users/someone -name x',
    'find /opt/homebrew ~ -name x',
    'find /* -name x',
    'find -L ~ -name x',
    'find ~ -maxdepth 6 -name x',
    'find . -name x',
    'cd && find . -name x',
    'cd ~/dev && cd .. && find . -name x',
    'sudo find / -name x',
    'sh -c "find / -name x"',
  ]) assert.equal(reason(command, command.startsWith('find .') ? home : repo), findHint, command);
});

test('allows find under a narrower root or with a shallow depth', () => {
  for (const command of [
    'find . -name x',
    'find src -name "*.ts"',
    'find /opt/homebrew/bin -name rg',
    'find ~/dev/app -name x',
    'find ~ -maxdepth 2 -name x',
    'find / -maxdepth 1 -type d',
    'cd ~/dev/app && find . -name x',
    'find $SOMEWHERE -name x',
    'echo "find / -name x"',
    'fd x ~',
  ]) assert.equal(reason(command), undefined, command);
  assert.equal(reason('cd ~/dev/app && find . -name x', home), undefined);
  assert.equal(reason('cd - && find . -name x', home), undefined);
});

test('the tool_call hook blocks only bash calls that trip the guard', async () => {
  /** @type {Map<string, (event: any, ctx: any) => any>} */
  const handlers = new Map();
  registerSearchGuard(/** @type {any} */ ({ on(/** @type {string} */ name, /** @type {any} */ fn) { handlers.set(name, fn); } }));
  const onToolCall = handlers.get('tool_call');
  assert.ok(onToolCall);
  const ctx = { cwd: repo };
  /** @param {string} toolName @param {Record<string, unknown>} input */
  const call = (toolName, input) => onToolCall({ type: 'tool_call', toolCallId: 'call', toolName, input }, ctx);
  assert.deepEqual(await call('bash', { command: 'grep -rn foo .' }), { block: true, reason: grepHint });
  assert.deepEqual(await call('bash', { command: 'find / -name foo' }), { block: true, reason: findHint });
  assert.equal(await call('bash', { command: 'rg -n foo' }), undefined);
  assert.equal(await call('read', { path: 'grep -r' }), undefined);
});
