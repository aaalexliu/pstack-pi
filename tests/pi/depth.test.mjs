import assert from 'node:assert/strict';
import test from 'node:test';
import { runPiSmoke } from './runner.mjs';

const delegation = ['subagent', 'subagent_interrupt', 'subagent_resume', 'subagents_list'];

/** @param {Record<string, unknown>} request */
function toolNames(request) {
  return Array.isArray(request.tools) ? request.tools.map((tool) => tool.function.name) : [];
}

/** @param {Record<string, unknown>} request @param {string} id */
function toolResult(request, id) {
  assert.ok(Array.isArray(request.messages));
  return JSON.stringify(request.messages.find((message) => message.role === 'tool' && message.tool_call_id === id)?.content);
}

// The runner starts a lead at the top level, with only these two subagent variables set.
test('a lead started the way the runner starts it has both delegation tool sets', async () => {
  await runPiSmoke({
    launchEnvironment: { PI_SUBAGENT_ID: 'KEY-1', PI_SUBAGENT_ACTIVITY_FILE: '/dev/null' },
    fixture: { script: [{ reply: { kind: 'text', text: 'lead ready' }, check: (request) => {
      for (const tool of delegation) assert.ok(toolNames(request).includes(tool), `Lead has ${tool}`);
    } }] },
    expectedText: 'lead ready',
  });
});

// The environment the `subagent` tool gives a `sub-lead` child, whose PI_DENY_TOOLS names every spawning tool (additions/agents/sub-lead.md: spawning false, auto-exit). A `pi -p` the sub-lead runs from bash inherits it, so a third level gets no delegation either.
test('a sub-lead and a pi -p it starts have no delegation tools', async () => {
  const final = 'sub-lead checked';
  await runPiSmoke({
    launchEnvironment: {
      PI_DENY_TOOLS: 'subagent,subagent_interrupt,subagents_list,subagent_resume',
      PI_SUBAGENT_NAME: 'ALE-50', PI_SUBAGENT_AGENT: 'sub-lead', PI_SUBAGENT_AUTO_EXIT: '1',
    },
    expectedRequests: 3, expectedText: final,
    fixture: { script: [
      { reply: { kind: 'tool', id: 'nested', name: 'bash', arguments: { command: 'pi -p "say nested"' } }, check: (request) => {
        for (const tool of delegation) assert.ok(!toolNames(request).includes(tool), `Sub-lead lacks ${tool}`);
        assert.ok(toolNames(request).includes('bash'));
      } },
      { reply: { kind: 'text', text: 'nested reply' }, check: (request) => {
        assert.ok(toolNames(request).includes('pstack_todo'), 'Nested pi -p loaded the package');
        for (const tool of delegation) assert.ok(!toolNames(request).includes(tool), `Nested pi -p lacks ${tool}`);
      } },
      { reply: { kind: 'text', text: final }, check: (request) => assert.match(toolResult(request, 'nested'), /nested reply/) },
    ] },
  });
});
