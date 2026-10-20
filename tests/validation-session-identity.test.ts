import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "../src/types";

// Isolated protocol identities; no test data is imported into the application.
const initial: Client = {
  id: "VDS-999999", client: "Identité technique A", contact: "Contact A", address: "", modelTeam: "",
  techMacon: "", finance: "", statusAction: "", category: "non_verifie", soldeAmount: null, contractHT: null,
};

test("session notes and markers cannot cross identity changes or survive logout", async () => {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: "custom", logLevel: "silent" });
  try {
    const { createSessionReviewMemory } = await vite.ssrLoadModule("/src/components/RealValidationCenter.tsx");
    const memory = createSessionReviewMemory();
    memory.reconcile([initial]);
    assert.equal(memory.append(initial, "note", "Note technique isolée"), true);
    assert.equal(memory.append(initial, "marked", "Marqueur technique"), true);
    let view = memory.reconcile([initial]);
    assert.equal(view[initial.id].events.length, 2);
    assert.equal(view[initial.id].marked, true);
    assert.deepEqual(JSON.parse(view[initial.id].events[0].source).slice(0, 3), [initial.id, initial.client, initial.contact]);

    const changedFinance = { ...initial, finance: "Texte source mis à jour" };
    assert.equal(memory.reconcile([changedFinance])[initial.id].events.length, 2, "Same identity may retain dated review history");

    // This is the first read of a remounted view: no effect or subsequent render is needed.
    const changedName = { ...initial, client: "Identité technique B" };
    assert.deepEqual(memory.reconcile([changedName]), {}, "The new person never sees previous notes or markers");
    assert.equal(memory.append(initial, "note", "Ancien gestionnaire capturé"), false, "Stale handlers cannot restore old notes");
    assert.deepEqual(memory.reconcile([initial]), {}, "Returning to the former identity cannot resurrect purged notes");

    memory.append(initial, "note", "Nouvelle note technique");
    assert.deepEqual(memory.reconcile([{ ...initial, contact: "Contact modifié" }]), {}, "A contact-only change also purges notes");
    memory.reconcile([initial]);
    memory.append(initial, "marked", "Marqueur technique");
    memory.reconcile([]);
    assert.deepEqual(memory.reconcile([initial]), {}, "Removal from the snapshot also purges the entry");
    memory.append(initial, "note", "Avant déconnexion");
    memory.clear();
    assert.deepEqual(memory.reconcile([initial]), {}, "Logout clears memory even between mounts");
  } finally { await vite.close(); }
});
