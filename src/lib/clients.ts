import type { Category, Client, ClientFilters, RecordKind } from "../types";

export const DEFAULT_FILTERS: ClientFilters = {
  search: "",
  status: "all",
  team: "all",
  model: "all",
  sort: "mixed",
};

export const TEAM_OPTIONS = [
  { value: 'all', label: 'Toute l’équipe' },
  { value: 'valérie', label: 'Valérie' },
  { value: 'maëlle', label: 'Maëlle' },
  { value: 'hans', label: 'Hans' },
  { value: 'alexandra', label: 'Alexandra' },
  { value: 'chris', label: 'Chris' },
  { value: 'thibault', label: 'Thibault' },
  { value: 'jean', label: 'Jean' },
  { value: 'costa', label: 'Costa' },
  { value: 'gael', label: 'Gael' },
];

export const MODEL_OPTIONS = [
  { value: "all", label: "Toutes les gammes" },
  { value: "family", label: "Family" },
  { value: "serenity", label: "Serenity" },
  { value: "cosy", label: "Cosy & Cosy XL" },
  { value: "volet imm", label: "Volet immergé" },
  { value: "volet solaire", label: "Volet solaire" },
  { value: "volet hors-sol", label: "Volet hors-sol" },
];

export const SORT_OPTIONS: { value: ClientFilters["sort"]; label: string }[] = [
  { value: "mixed", label: "Vue équilibrée" },
  { value: "id_asc", label: "Identifiant" },
  { value: "name_asc", label: "Client · A à Z" },
  { value: "solde_desc", label: "Solde décroissant" },
  { value: "ht_desc", label: "Contrat HT décroissant" },
];

export const RECORD_STATUSES: Record<RecordKind, readonly string[]> = {
  devis: ["Brouillon", "Envoyé", "Accepté"],
  ventes: ["Confirmée", "En préparation", "Livrée"],
  chantiers: ["Planifié", "En cours", "Terminé"],
  factures: ["À envoyer", "En attente", "Payée"],
  sav: ["Ouvert", "En cours", "Résolu"],
};

export function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase("fr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const searchCache = new WeakMap<
  Client,
  { haystack: string; phone: string; modelTeam: string }
>();
function searchable(client: Client) {
  let result = searchCache.get(client);
  if (!result) {
    result = {
      haystack: normalizeText(
        [
          client.id,
          client.client,
          client.contact,
          client.address,
          client.modelTeam,
          client.techMacon,
          client.finance,
          client.statusAction,
          client.soldeAmount,
          client.contractHT,
        ].join(" "),
      ),
      phone: client.contact.replace(/\D/g, ""),
      modelTeam: normalizeText(client.modelTeam),
    };
    searchCache.set(client, result);
  }
  return result;
}

const compareId = (a: Client, b: Client) =>
  a.id.localeCompare(b.id, "fr", { numeric: true });

const compareNullableAmount = (a: number | null, b: number | null) =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : b - a;

/** Pure filtering: never mutates source rows or the selected client. */
export function filterClients(
  clients: Client[],
  filters: ClientFilters,
): Client[] {
  const query = normalizeText(filters.search);
  const exactId = query && clients.some((client) => normalizeText(client.id) === query);
  const terms = query.split(" ").filter(Boolean);
  const phoneOnly =
    /^[+\d\s()./-]+$/.test(filters.search.trim()) &&
    query.replace(/\D/g, "").length >= 5;
  const phoneQuery = query.replace(/\D/g, "");
  const result = clients.filter((client) => {
    if (filters.status === "followup" && (client.soldeAmount === null || client.soldeAmount <= 0)) return false;
    if (
      filters.status !== "all" &&
      filters.status !== "followup" &&
      client.category !== filters.status
    )
      return false;
    const index = searchable(client);
    if (
      filters.team !== "all" &&
      !index.modelTeam.includes(normalizeText(filters.team))
    )
      return false;
    if (
      filters.model !== "all" &&
      !index.modelTeam.includes(normalizeText(filters.model))
    )
      return false;
    if (!query) return true;
    if (exactId) return normalizeText(client.id) === query;
    if (phoneOnly)
      return index.phone.includes(phoneQuery) || index.haystack.includes(query);
    return terms.every(
      (term) =>
        index.haystack.includes(term) ||
        (/^\d{5,}$/.test(term) && index.phone.includes(term)),
    );
  });
  switch (filters.sort) {
    case "id_asc":
      return result.sort(compareId);
    case "name_asc":
      return result.sort(
        (a, b) => a.client.localeCompare(b.client, "fr") || compareId(a, b),
      );
    case "solde_desc":
      return result.sort(
        (a, b) => compareNullableAmount(a.soldeAmount, b.soldeAmount) || compareId(a, b),
      );
    case "ht_desc":
      return result.sort(
        (a, b) => compareNullableAmount(a.contractHT, b.contractHT) || compareId(a, b),
      );
    case "mixed": {
      const groups = Object.fromEntries(
        ["alerte", "solde", "sav", "valide", "non_verifie"].map((category) => [
          category,
          result
            .filter((client) => client.category === category)
            .sort(compareId),
        ]),
      ) as Record<Category, Client[]>;
      const positions: Record<Category, number> = {
        alerte: 0,
        solde: 0,
        sav: 0,
        valide: 0,
        non_verifie: 0,
      };
      const pattern: Category[] = [
        "alerte",
        "solde",
        "sav",
        "valide",
        "non_verifie",
        "solde",
        "sav",
      ];
      const mixed: Client[] = [];
      while (mixed.length < result.length) {
        for (const category of pattern) {
          const row = groups[category][positions[category]];
          if (row) {
            mixed.push(row);
            positions[category]++;
          }
        }
      }
      return mixed;
    }
  }
}

export function getCounts(clients: Client[]) {
  return clients.reduce(
    (counts, client) => {
      counts.total++;
      counts[client.category]++;
      counts.followup += client.soldeAmount !== null && client.soldeAmount > 0 ? 1 : 0;
      return counts;
    },
    {
      total: 0,
      alerte: 0,
      solde: 0,
      sav: 0,
      valide: 0,
      non_verifie: 0,
      followup: 0,
    },
  );
}

export function buildClientMessage(client: Client): string {
  return `Bonjour ${client.client}, point dossier ${client.id} (VDS Pools) : ${client.statusAction} (${client.finance}).`;
}

/** Identity changes invalidate an open dossier instead of silently switching people. */
export function clientIdentityKey(client: Pick<Client, "id" | "client" | "contact">): string {
  return JSON.stringify([client.id, client.client.trim().normalize("NFC"), client.contact.trim().normalize("NFC")]);
}
