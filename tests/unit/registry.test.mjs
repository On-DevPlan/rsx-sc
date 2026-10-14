// Asserts that:
//   - Every VIEWS entry has a matching MODULE (every tab points to a real
//     module — otherwise the tab crashes when clicked).
//   - Every MODULE's action declares both `cli` and `http` (or null), per
//     the registry invariant in src/runtime/registry.js.
//   - Every action has a `run` function.
//
// We don't require the reverse direction: a MODULE may be CLI-only with no
// VIEWS entry (e.g. `skill` is reachable from `rsx-sc skill ...` but has no
// panel tab).

import test from 'node:test';
import assert from 'node:assert/strict';

import { MODULES } from '../../src/runtime/registry.js';
import { VIEWS } from '../../src/web/frontend/registry.js';

test('every VIEWS entry has a matching MODULE', () => {
  const moduleIds = new Set(MODULES.map((m) => m.id));
  const missing = VIEWS.map((v) => v.id).filter((id) => !moduleIds.has(id));
  assert.deepEqual(missing, [], `VIEWS not in MODULES: ${JSON.stringify(missing)}`);
});

test('every action declares both cli and http (or null)', () => {
  for (const m of MODULES) {
    for (const a of m.actions || []) {
      assert.ok(Array.isArray(a.cli) && a.cli.length > 0, `${a.id}: cli must be non-empty array`);
      assert.ok(
        a.http === null || (Array.isArray(a.http) && a.http.length === 2),
        `${a.id}: http must be null or [method, path]`
      );
    }
  }
});

test('every action has a run fn', () => {
  for (const m of MODULES) {
    for (const a of m.actions || []) {
      assert.equal(typeof a.run, 'function', `${a.id}: run must be a function`);
    }
  }
});