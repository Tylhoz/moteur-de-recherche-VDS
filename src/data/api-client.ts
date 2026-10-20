import type { Snapshot, SnapshotSourceState } from "../types";

export const AUTHENTICATION_REQUIRED_EVENT = "vds:authentication-required";
export const SNAPSHOT_ENDPOINT = "/api/v1/portal-snapshot";
export const REFRESH_INTERVAL_MS = 30_000;

export class PortalApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "PortalApiError";
  }
  get requiresAuthentication() { return this.status === 401 || this.status === 403; }
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown) => value === null || date(value);
const safeReference = (value: unknown) => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      ["docs.google.com", "drive.google.com", "mail.google.com", "calendar.google.com"].includes(url.hostname) &&
      !/(?:access.?token|refresh.?token|api.?key|secret|password|signature|credential)/i.test(decodeURIComponent(url.href));
  } catch { return false; }
};

/** Fail closed: a malformed API response never replaces the last valid copy. */
export function validatePortalSnapshot(value: unknown): Snapshot {
  if (!object(value) || value.source !== "api" || typeof value.version !== "string" || !value.version ||
      !date(value.fetchedAt) || !Array.isArray(value.clients) || !Array.isArray(value.records) ||
      !object(value.connection) || value.connection.mode !== "readonly-api" ||
      typeof value.connection.label !== "string" || typeof value.connection.sheetReady !== "boolean" ||
      value.connection.intervalMs !== REFRESH_INTERVAL_MS || !object(value.sourceState) ||
      !nullableDate(value.sourceState.lastReadAt) || !nullableDate(value.sourceState.lastAttemptAt) ||
      typeof value.sourceState.stale !== "boolean" ||
      !["ready", "stale", "not_connected"].includes(String(value.sourceState.status)) ||
      (value.sourceState.reason !== undefined && typeof value.sourceState.reason !== "string") ||
      (value.sourceState.revision !== undefined && typeof value.sourceState.revision !== "string")) {
    throw new PortalApiError("La réponse de l’API est invalide. La dernière copie valide est conservée.");
  }
  const ids = new Set<string>();
  for (const client of value.clients) {
    if (!object(client) || typeof client.id !== "string" || !/^VDS-\d+$/.test(client.id) || ids.has(client.id) ||
        !["client", "contact", "address", "modelTeam", "techMacon", "finance", "statusAction"].every(key => typeof client[key] === "string") ||
        !String(client.client).trim() || !["alerte", "solde", "sav", "valide", "non_verifie"].includes(String(client.category)) ||
        (client.soldeAmount !== null && (typeof client.soldeAmount !== "number" || !Number.isFinite(client.soldeAmount))) ||
        (client.contractHT !== null && (typeof client.contractHT !== "number" || !Number.isFinite(client.contractHT)))) {
      throw new PortalApiError("La liste des dossiers est invalide ou comporte des identifiants en double.");
    }
    ids.add(client.id);
  }
  // This route carries original dossiers only. Structured business records use dedicated APIs.
  if (value.records.length !== 0 || (value.links !== undefined && (!Array.isArray(value.links) ||
      !value.links.every(link => object(link) && typeof link.label === "string" && safeReference(link.url)))) ||
      (value.enrichedClientIds !== undefined && (!Array.isArray(value.enrichedClientIds) ||
        !value.enrichedClientIds.every(id => typeof id === "string" && ids.has(id)) ||
        new Set(value.enrichedClientIds).size !== value.enrichedClientIds.length))) {
    throw new PortalApiError("Les références des dossiers reçus ne sont pas valides.");
  }
  return value as unknown as Snapshot;
}

export interface SnapshotRead {
  snapshot: Snapshot;
  /** Time the browser checked the API; this is not a Google synchronization time. */
  checkedAt: string;
}

/** Per-hook memory only. No localStorage, browser credentials, public asset or fallback. */
export function createPortalSnapshotClient(fetcher: typeof fetch = fetch) {
  let cached: Snapshot | null = null;
  let etag: string | null = null;
  let pending: Promise<SnapshotRead> | null = null;
  let controller: AbortController | null = null;
  let generation = 0;

  function clear() {
    generation++;
    controller?.abort();
    controller = null;
    pending = null;
    cached = null;
    etag = null;
  }
  function read(): Promise<SnapshotRead> {
    if (pending) return pending;
    const currentGeneration = generation;
    const requestController = new AbortController();
    controller = requestController;
    const timeout = setTimeout(() => requestController.abort(), 20_000);
    const task = (async () => {
      let response: Response;
      try {
        response = await fetcher(SNAPSHOT_ENDPOINT, {
          method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
          headers: { Accept: "application/json", ...(etag ? { "If-None-Match": etag } : {}) },
          signal: requestController.signal,
        });
      } catch {
        throw new PortalApiError("Synchronisation indisponible. Impossible de joindre l’API privée.");
      }
      if (currentGeneration !== generation) throw new PortalApiError("La lecture a été interrompue.");
      if (response.status === 401 || response.status === 403) {
        cached = null;
        etag = null;
        throw new PortalApiError("Votre session doit être renouvelée. Identifiez-vous à nouveau pour consulter les dossiers.", response.status);
      }
      const checkedAt = new Date().toISOString();
      if (response.status === 304 && cached) {
        const state = { ...cached.sourceState! };
        const readAt = response.headers.get("X-VDS-Last-Read-At");
        const attemptedAt = response.headers.get("X-VDS-Last-Attempt-At");
        const fetchedAt = response.headers.get("X-VDS-Fetched-At");
        const stale = response.headers.get("X-VDS-Source-Stale");
        if (date(readAt)) state.lastReadAt = readAt;
        if (date(attemptedAt)) state.lastAttemptAt = attemptedAt;
        if (stale === "true" || stale === "false") {
          state.stale = stale === "true";
          if (state.status !== "not_connected") state.status = state.stale ? "stale" : "ready";
        }
        cached = { ...cached, fetchedAt: date(fetchedAt) ? fetchedAt! : cached.fetchedAt, sourceState: state };
        return { snapshot: cached, checkedAt };
      }
      if (response.ok && response.headers.get("Content-Type")?.toLowerCase().includes("text/html")) {
        throw new PortalApiError("Interface publiée, API non déployée. Ouvrez Données & accès pour vérifier l’environnement privé.", response.status);
      }
      if (!response.ok || !response.headers.get("Content-Type")?.includes("application/json")) {
        throw new PortalApiError(response.status === 503
          ? "Source non connectée ou synchronisation indisponible. La source privée doit être configurée côté serveur."
          : "Synchronisation indisponible. L’API privée n’a pas fourni de données exploitables.", response.status);
      }
      let value: unknown;
      try { value = await response.json(); }
      catch { throw new PortalApiError("La réponse de l’API est illisible."); }
      if (currentGeneration !== generation) throw new PortalApiError("La lecture a été interrompue.");
      const validated = validatePortalSnapshot(value);
      cached = validated;
      etag = response.headers.get("ETag");
      return { snapshot: validated, checkedAt };
    })();
    pending = task;
    void task.finally(() => {
      clearTimeout(timeout);
      if (pending === task) { pending = null; controller = null; }
    }).catch(() => {});
    return task;
  }
  return { read, clear };
}

export function staleSourceState(state?: SnapshotSourceState): SnapshotSourceState {
  return {
    lastReadAt: state?.lastReadAt ?? null,
    lastAttemptAt: state?.lastAttemptAt ?? null,
    ...state,
    stale: true,
    status: state?.status === "not_connected" ? "not_connected" : "stale",
  };
}
