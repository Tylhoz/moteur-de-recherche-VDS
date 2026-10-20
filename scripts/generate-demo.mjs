import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * A standalone, deterministic fixture. No customer file, network service,
 * environment variable or historical snapshot is ever read by this generator.
 */
export function createDemoSnapshot() {
  const models = ["Family", "Serenity", "Cosy"];
  const teams = ["Équipe Horizon", "Équipe Azur", "Équipe Jardin"];
  const categories = ["alerte", "solde", "sav", "valide"];
  const actions = {
    alerte: "Démonstration : contrôler les informations du dossier fictif.",
    solde: "Démonstration : vérifier le solde fictif avant toute action.",
    sav: "Démonstration : examiner la demande de suivi fictive.",
    valide: "Démonstration : dossier fictif sans anomalie signalée.",
  };

  const clients = Array.from({ length: 500 }, (_, index) => {
    const number = index + 1;
    const identifier = String(number).padStart(3, "0");
    const category =
      index < 3 ? "alerte" : categories[index % categories.length];
    const contractHT =
      [42_500, 30_000, 28_000][index] ?? 24_000 + ((number * 37) % 80) * 500;
    const soldeAmount =
      category === "valide"
        ? 0
        : Math.round(contractHT * [0.3, 0.5, 0.2][index % 3]);

    return {
      id: `DEMO-${identifier}`,
      client: `Client démonstration ${identifier}`,
      contact: "Non renseigné · dossier fictif",
      address: `${number} allée Exemple, Ville fictive`,
      modelTeam: `${models[index % models.length]} · ${teams[index % teams.length]} · projet fictif`,
      techMacon: "Équipe technique de démonstration · intervention fictive",
      finance: `Montant fictif : ${contractHT} EUR HT · solde fictif : ${soldeAmount} EUR`,
      statusAction:
        index === 0
          ? "Démonstration : écart de 3 000 EUR entre deux montants fictifs ; validation nécessaire."
          : index === 1
            ? "Démonstration : vérifier les bases HT et TTC avant de comparer les montants fictifs."
            : index === 2
              ? "Démonstration : justificatif d’encaissement manquant ; aucune validation automatique."
              : actions[category],
      category,
      soldeAmount,
      contractHT,
    };
  });

  const digest = createHash("sha256")
    .update(JSON.stringify(clients))
    .digest("hex")
    .slice(0, 16);
  return {
    source: "demo",
    version: `vds-validation-demo-v1-${digest}`,
    fetchedAt: "2026-10-19T12:00:00.000Z",
    clients,
    records: [],
    links: [],
    connection: {
      mode: "offline",
      label: "Démonstration fictive · aucun service connecté",
      intervalMs: 30_000,
      sheetReady: false,
    },
  };
}

const invokedAsScript =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  const target = process.argv[2]
    ? resolve(process.argv[2])
    : fileURLToPath(new URL("../tests/fixtures/demo-snapshot.json", import.meta.url));
  await mkdir(dirname(target), { recursive: true });
  const snapshot = createDemoSnapshot();
  await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Generated ${snapshot.clients.length} exclusively synthetic demonstration dossiers.\n`,
  );
}
