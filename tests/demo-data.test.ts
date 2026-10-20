import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Client } from "../src/types";

const fixtureUrl = new URL("./fixtures/demo-snapshot.json", import.meta.url);
const generatorUrl = new URL("../scripts/generate-demo.mjs", import.meta.url)
  .href;
const readFixture = async () =>
  JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    source: string;
    version: string;
    fetchedAt: string;
    clients: Client[];
    records: unknown[];
    links: unknown[];
    connection: { mode: string; sheetReady: boolean; label: string };
  };

test("the isolated test fixture contains exactly 500 uniquely identified fictional dossiers", async () => {
  const snapshot = await readFixture();
  assert.equal(snapshot.source, "demo");
  assert.equal(snapshot.clients.length, 500);
  assert.equal(new Set(snapshot.clients.map((client) => client.id)).size, 500);
  for (const [index, client] of snapshot.clients.entries()) {
    const identifier = String(index + 1).padStart(3, "0");
    assert.equal(client.id, `DEMO-${identifier}`);
    assert.equal(client.client, `Client démonstration ${identifier}`);
    assert.equal(client.contact, "Non renseigné · dossier fictif");
    assert.equal(client.address, `${index + 1} allée Exemple, Ville fictive`);
    assert.match(
      client.modelTeam,
      /^(Family|Serenity|Cosy) · Équipe (Horizon|Azur|Jardin) · projet fictif$/u,
    );
    assert.match(client.techMacon, /démonstration/u);
    assert.match(client.finance, /fictif/u);
    assert.match(client.statusAction, /^Démonstration : /u);
    assert.ok(Number.isSafeInteger(client.contractHT) && (client.contractHT ?? 0) > 0);
    assert.ok(
      Number.isSafeInteger(client.soldeAmount) && (client.soldeAmount ?? 0) >= 0,
    );
    assert.ok((client.soldeAmount ?? 0) <= (client.contractHT ?? 0));
    assert.ok(["alerte", "solde", "sav", "valide"].includes(client.category));
  }
});

test("the demo contains no external links, contact details or connected services", async () => {
  const snapshot = await readFixture();
  assert.deepEqual(snapshot.records, []);
  assert.deepEqual(snapshot.links, []);
  assert.equal(snapshot.connection.mode, "offline");
  assert.equal(snapshot.connection.sheetReady, false);
  assert.match(snapshot.connection.label, /fictive/u);
  const text = JSON.stringify(snapshot);
  assert.doesNotMatch(
    text,
    /https?:\/\/|www\.|mailto:|tel:|@[\w.-]+\.[a-z]{2,}/iu,
  );
  assert.doesNotMatch(
    text,
    /AIza[\w-]{20,}|sk-[a-zA-Z0-9]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  );
});

test("the first three dossiers support the financial validation demonstrations", async () => {
  const { clients } = await readFixture();
  assert.equal(clients[0].contractHT, 42_500);
  assert.match(clients[0].statusAction, /écart de 3 000 EUR/u);
  assert.equal(clients[1].contractHT, 30_000);
  assert.match(clients[1].statusAction, /HT et TTC/u);
  assert.equal(clients[2].contractHT, 28_000);
  assert.match(
    clients[2].statusAction,
    /justificatif d’encaissement manquant/u,
  );
  assert.ok(
    clients.slice(0, 3).every((client) => client.category === "alerte"),
  );
});

test("the generated snapshot is reproducible and matches the committed fixture", async () => {
  const { createDemoSnapshot } = await import(generatorUrl);
  const first = createDemoSnapshot();
  const second = createDemoSnapshot();
  assert.deepEqual(first, second);
  assert.equal(
    `${JSON.stringify(first, null, 2)}\n`,
    await readFile(fixtureUrl, "utf8"),
  );
  assert.equal(first.fetchedAt, "2026-10-19T12:00:00.000Z");
  assert.match(first.version, /^vds-validation-demo-v1-[a-f0-9]{16}$/u);
});
