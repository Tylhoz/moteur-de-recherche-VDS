import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FILTERS, filterClients } from '../src/lib/clients';
import type { Client } from '../src/types';

const common = {
  contact: '', address: 'Ville fictive', modelTeam: 'Family · Équipe Horizon',
  techMacon: '', finance: '', statusAction: '', category: 'alerte' as const,
  soldeAmount: 0, contractHT: 0,
};
const clients: Client[] = [
  { ...common, id: 'DEMO-005', client: 'Client démonstration 005' },
  { ...common, id: 'DEMO-014', client: 'Client démonstration 014', contractHT: 100500 },
];

test('an exact dossier ID cannot match unrelated financial digits in another dossier', () => {
  assert.deepEqual(filterClients(clients, { ...DEFAULT_FILTERS, search: 'demo-005' }).map(c => c.id), ['DEMO-005']);
  assert.deepEqual(filterClients(clients, { ...DEFAULT_FILTERS, search: '  Démo 005  ' }).map(c => c.id), ['DEMO-005']);
  assert.deepEqual(filterClients(clients, { ...DEFAULT_FILTERS, search: 'demo-005', status: 'sav' }), []);
});

test('free-text searches still accept accents and combine with team filters', () => {
  assert.equal(filterClients(clients, { ...DEFAULT_FILTERS, search: 'demonstration horizon' }).length, 2);
  assert.equal(filterClients(clients, { ...DEFAULT_FILTERS, search: 'démonstration', team: 'azur' }).length, 0);
  assert.deepEqual(clients.map(c => c.id), ['DEMO-005', 'DEMO-014']);
});
