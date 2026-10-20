import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "../types";
import {
  AUTHENTICATION_REQUIRED_EVENT, createPortalSnapshotClient, PortalApiError,
  REFRESH_INTERVAL_MS, staleSourceState,
} from "./api-client";

/** Private server API; remote source readings and browser attempts stay distinct. */
export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [lastAttemptAt, setLastAttemptAt] = useState<string | null>(null);
  const client = useRef(createPortalSnapshotClient());
  const mounted = useRef(false);
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const version = generation.current;
    setRefreshing(true);
    setLastAttemptAt(new Date().toISOString());
    const task = (async () => {
      try {
        const result = await client.current.read();
        if (!mounted.current || version !== generation.current) return;
        setSnapshot(result.snapshot);
        setLastCheckedAt(result.checkedAt);
        setError(null);
        setAuthenticationRequired(false);
      } catch (cause) {
        if (!mounted.current || version !== generation.current) return;
        if (cause instanceof PortalApiError && cause.requiresAuthentication) {
          setSnapshot(null);
          setLastCheckedAt(null);
          window.dispatchEvent(new Event(AUTHENTICATION_REQUIRED_EVENT));
        } else {
          setSnapshot(previous => previous ? { ...previous, sourceState: staleSourceState(previous.sourceState) } : null);
        }
        setError(cause instanceof Error ? cause.message : "Synchronisation indisponible.");
      } finally {
        if (mounted.current && version === generation.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();
    inFlight.current = task;
    void task.finally(() => { if (inFlight.current === task) inFlight.current = null; });
    return task;
  }, []);
  useEffect(() => {
    mounted.current = true;
    const revoked = () => {
      generation.current++;
      client.current.clear();
      inFlight.current = null;
      setSnapshot(null);
      setLastCheckedAt(null);
      setError("Votre session doit être renouvelée. Identifiez-vous à nouveau pour consulter les dossiers.");
      setAuthenticationRequired(true);
      setLoading(false);
      setRefreshing(false);
    };
    window.addEventListener(AUTHENTICATION_REQUIRED_EVENT, revoked);
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, REFRESH_INTERVAL_MS);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false;
      generation.current++;
      client.current.clear();
      inFlight.current = null;
      clearInterval(timer);
      window.removeEventListener(AUTHENTICATION_REQUIRED_EVENT, revoked);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  return { snapshot, loading, refreshing, error, authenticationRequired, lastCheckedAt, lastAttemptAt, refresh };
}
