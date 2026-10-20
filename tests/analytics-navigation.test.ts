import test from 'node:test';
import assert from 'node:assert/strict';
import { ANALYSIS_LABELS, readRoute, routeUrl } from '../src/lib/navigation.js';

test('each indicator has a dedicated shareable analysis route and preserves it when opening a dossier', () => {
  for (const metric of Object.keys(ANALYSIS_LABELS)) {
    const route = readRoute(`#analysis?metric=${metric}`);
    assert.equal(route.section, 'analysis'); assert.equal(route.metric, metric);
    assert.equal(route.selectedId, null);
    const withClient = { ...route, selectedId: 'VDS-003' };
    assert.deepEqual(readRoute(routeUrl(withClient)), withClient);
    assert.equal(readRoute(routeUrl({ ...withClient, selectedId: null })).metric, metric);
  }
});

test('invalid routes and metrics fall back safely, and client filters survive the round trip', () => {
  assert.equal(readRoute('').section, 'dashboard');
  assert.equal(readRoute('#unknown?client=../../etc/passwd').selectedId, null);
  assert.equal(readRoute('#analysis?metric=__proto__').metric, 'clients');
  const route = readRoute('#clients?q=Serenity&status=non_verifie&team=all&model=all&sort=name_asc&client=VDS-003');
  assert.deepEqual(readRoute(routeUrl(route)), route);
});
