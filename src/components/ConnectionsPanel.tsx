import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, Database, ExternalLink, FileJson, LockKeyhole, RefreshCw, Server, ShieldCheck, Upload } from 'lucide-react';
import type { SourceLink } from '../types';
import { AUTHENTICATION_REQUIRED_EVENT } from '../data/api-client';
import {
  ConnectionsError, FIELD_LABELS, MAX_PRIVATE_ARCHIVE_BYTES, mayApplyPreview, messageFor, previewRequiresIdentityReview, readPrivateJson,
  validateApprovalReceipt, validateImportReceipt, validateIntegrations, validateSetup, validateSheetsPreview, validateStoredPreview,
  type ApprovalReceipt, type ImportReceipt, type IntegrationStatus, type SetupStatus, type SheetsPreview,
} from '../data/connections-client';
import './connections-panel.css';

type Props = {
  links?: SourceLink[]; lastReadAt?: string | null; lastCheckedAt?: string | null; lastAttemptAt?: string | null;
  formatDate: (value: string) => string; onImported: () => Promise<void>;
};
const errorOf = (error: unknown) => error instanceof ConnectionsError ? error : new ConnectionsError('invalid_response');
const PAGE_SIZE = 12;
const STORAGE_LABELS: Record<SetupStatus['storage']['state'], string> = {
  ready: 'Archive privée disponible', empty: 'Archive à importer', unavailable: 'Archive indisponible', not_configured: 'Stockage à configurer',
};
function Failure({ error }: { error: ConnectionsError }) {
  return <div className="connections-error" role="alert"><AlertCircle size={19} /><div>
    <p>{error.message}</p>
    {['authentication_required', 'access_forbidden'].includes(error.code) && <a href="/">Se reconnecter <ArrowRight size={14} /></a>}
  </div></div>;
}
function ProviderBadge({ configured, checked, connected }: { configured: boolean; checked: boolean; connected: boolean }) {
  const label = connected && checked ? 'Lecture vérifiée' : !configured ? 'À configurer' : checked ? 'Connexion indisponible' : 'Configuré · à vérifier';
  return <span className={`connections-badge ${connected && checked ? 'verified' : ''}`}>{label}</span>;
}

export default function ConnectionsPanel({ links = [], lastReadAt, lastCheckedAt, lastAttemptAt, formatDate, onImported }: Props) {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationStatus | null>(null);
  const [setupError, setSetupError] = useState<ConnectionsError | null>(null);
  const [integrationError, setIntegrationError] = useState<ConnectionsError | null>(null);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<SheetsPreview | null>(null);
  const [previewError, setPreviewError] = useState<ConnectionsError | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [page, setPage] = useState(1);
  const [archive, setArchive] = useState<File | null>(null);
  const [importError, setImportError] = useState<ConnectionsError | null>(null);
  const [receipt, setReceipt] = useState<ImportReceipt | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvalReceipt, setApprovalReceipt] = useState<ApprovalReceipt | null>(null);
  const approvalController = useRef<AbortController | null>(null);
  const statusController = useRef<AbortController | null>(null);
  const previewController = useRef<AbortController | null>(null);
  const importController = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    statusController.current?.abort();
    const controller = new AbortController(); statusController.current = controller;
    setLoading(true); setSetup(null); setIntegrations(null); setSetupError(null); setIntegrationError(null);
    setConfirmed(false);
    const [server, sources, proposal] = await Promise.allSettled([
      readPrivateJson('/api/v1/setup', { signal: controller.signal }).then(validateSetup),
      readPrivateJson('/api/v1/integrations', { signal: controller.signal }).then(validateIntegrations),
      readPrivateJson('/api/v1/integrations/sheets/preview', { signal: controller.signal }).then(validateStoredPreview),
    ]);
    if (controller.signal.aborted) return;
    if (server.status === 'fulfilled') setSetup(server.value); else setSetupError(errorOf(server.reason));
    if (sources.status === 'fulfilled') setIntegrations(sources.value); else setIntegrationError(errorOf(sources.reason));
    if (proposal.status === 'fulfilled') { setPreview(proposal.value); setPage(1); }
    else { setPreview(null); setPreviewError(errorOf(proposal.reason)); }
    setLoading(false);
  }, []);

  useEffect(() => {
    const revoke = () => {
      statusController.current?.abort(); previewController.current?.abort(); importController.current?.abort(); approvalController.current?.abort();
      setSetup(null); setIntegrations(null); setPreview(null); setArchive(null); setReceipt(null);
      setSetupError(new ConnectionsError('authentication_required')); setIntegrationError(null); setPreviewError(null); setImportError(null);
      setLoading(false); setPreviewing(false); setImporting(false);
      setConfirmed(false); setApproving(false); setApprovalReceipt(null);
      if (fileInput.current) fileInput.current.value = '';
    };
    window.addEventListener(AUTHENTICATION_REQUIRED_EVENT, revoke);
    void loadStatus();
    return () => {
      window.removeEventListener(AUTHENTICATION_REQUIRED_EVENT, revoke);
      statusController.current?.abort(); previewController.current?.abort(); importController.current?.abort(); approvalController.current?.abort();
    };
  }, [loadStatus]);

  async function checkSheets() {
    previewController.current?.abort();
    const controller = new AbortController(); previewController.current = controller;
    setPreviewing(true); setPreviewError(null); setPreview(null); setPage(1); setConfirmed(false); setApprovalReceipt(null);
    try {
      const result = validateSheetsPreview(await readPrivateJson('/api/v1/integrations/sheets/preview', {
        method: 'POST', body: '{}', signal: controller.signal,
      }));
      if (controller.signal.aborted) return;
      setPreview(result);
    } catch (error) { if (!controller.signal.aborted) setPreviewError(errorOf(error)); }
    finally { if (!controller.signal.aborted) { setPreviewing(false); void loadStatus(); } }
  }
  async function approvePreview() {
    if (!preview || !mayApplyPreview(preview, confirmed) || approving || previewing || loading || approvalReceipt?.revision === preview.revision) return;
    const controller = new AbortController(); approvalController.current = controller;
    setApproving(true); setPreviewError(null); setApprovalReceipt(null);
    try {
      const result = validateApprovalReceipt(await readPrivateJson('/api/v1/integrations/sheets/approve', {
        method: 'POST', body: JSON.stringify({ revision: preview.revision, confirm: true }), signal: controller.signal,
      }));
      if (controller.signal.aborted) return;
      setApprovalReceipt(result); setConfirmed(false);
      await Promise.all([loadStatus(), onImported()]);
    } catch (error) { if (!controller.signal.aborted) { setPreviewError(errorOf(error)); setConfirmed(false); } }
    finally { if (!controller.signal.aborted) setApproving(false); }
  }
  function selectArchive(file: File | undefined) {
    setReceipt(null); setImportError(null); setArchive(null);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.json') || !file.size || file.size > MAX_PRIVATE_ARCHIVE_BYTES) {
      setImportError(new ConnectionsError('archive_file_invalid'));
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setArchive(file);
  }
  async function importArchive() {
    if (!archive || setup?.storage.state !== 'empty' || importing) return;
    const controller = new AbortController(); importController.current = controller;
    setImporting(true); setImportError(null); setReceipt(null);
    try {
      const result = validateImportReceipt(await readPrivateJson('/api/v1/setup/import', {
        method: 'POST', body: archive, action: 'import', signal: controller.signal,
      }));
      if (controller.signal.aborted) return;
      setReceipt(result); setArchive(null);
      if (fileInput.current) fileInput.current.value = '';
      await Promise.all([loadStatus(), onImported()]);
    } catch (error) { if (!controller.signal.aborted) setImportError(errorOf(error)); }
    finally { if (!controller.signal.aborted) setImporting(false); }
  }

  const sheets = integrations?.sheets;
  const invoicing = integrations?.invoicing;
  const pageCount = preview ? Math.max(1, Math.ceil(preview.changes.length / PAGE_SIZE)) : 1;
  const displayedChanges = preview?.changes.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) ?? [];
  const duplicateError = setupError?.code === integrationError?.code;
  const sourceUrl = preview ? `https://docs.google.com/spreadsheets/d/${preview.source.spreadsheetId}/edit` : null;
  const identityReviewRequired = preview ? previewRequiresIdentityReview(preview) : false;
  const previewApplied = !!preview && approvalReceipt?.revision === preview.revision;

  return <div className="connections-panel">
    <div className="connections-intro">
      <div><p className="connections-eyebrow">VOTRE ESPACE PRIVÉ</p><h3>Les sources, en toute clarté.</h3>
        <p>Consultez l’état réel de l’accès, de l’archive et des connexions. Chaque écart reste visible avant toute validation.</p></div>
      <button className="connections-refresh" onClick={() => { setPreviewError(null); void loadStatus(); }} disabled={loading || approving || previewing || importing} aria-label="Vérifier l’état des connexions">
        <RefreshCw size={17} className={loading ? 'spinning' : ''} /> Vérifier
      </button>
    </div>
    {loading && <p className="connections-loading" role="status">Vérification du serveur privé…</p>}
    {setupError && <Failure error={setupError} />}
    {setup && <>
      <div className="connections-status-grid">
        <article><ShieldCheck size={21} /><span>Authentification</span><strong>Accès propriétaire vérifié</strong><small>{setup.authentication === 'owner-session' ? 'Session privée VDS' : 'Cloudflare Access'}</small></article>
        <article><Database size={21} /><span>Dossiers privés</span><strong>{STORAGE_LABELS[setup.storage.state]}</strong>
          {setup.storage.state === 'ready' && <small>{setup.storage.dossiers?.toLocaleString('fr-FR')} dossiers · {setup.storage.enriched?.toLocaleString('fr-FR')} fiches enrichies</small>}
          {setup.storage.state !== 'ready' && <small>Les compteurs s’affichent après une lecture réussie.</small>}
        </article>
        <article><Server size={21} /><span>Version du serveur</span><strong>{setup.release.id ?? 'Version non renseignée'}</strong>
          <small>{setup.release.commit ? <span title={setup.release.commit}>Commit {setup.release.commit.slice(0, 12)}</span> : 'Commit non renseigné'}</small></article>
      </div>
      <p className="connections-environment"><span className={setup.ready ? 'is-ready' : ''} />{setup.ready ? 'Environnement prêt' : 'Préparation de l’environnement incomplète'} · {setup.runtime === 'railway-node' ? 'Railway' : 'Cloudflare Workers'}</p>
      {setup.runtime === 'railway-node' && <form method="post" action="/auth/logout"><button className="connections-refresh" type="submit">Se déconnecter</button></form>}
    </>}

    {setup?.storage.state === 'empty' && <section className="connections-import" aria-labelledby="archive-import-title">
      <div className="connections-section-title"><FileJson size={22} /><div><h4 id="archive-import-title">Importer votre archive privée</h4><p>Cet environnement ne contient pas encore vos dossiers.</p></div></div>
      <p>Choisissez l’archive JSON préparée pour cet espace. Le serveur vérifiera son intégrité avant de l’enregistrer dans le stockage privé. Votre Google Sheets et l’ancienne version restent inchangés.</p>
      <label className="connections-file-label" htmlFor="private-archive-file">Archive privée · JSON · 4 Mio maximum</label>
      <input ref={fileInput} id="private-archive-file" type="file" accept=".json,application/json" disabled={importing} onChange={event => selectArchive(event.target.files?.[0])} />
      {archive && <div className="connections-file-review"><FileJson size={18} /><div><strong>{archive.name}</strong><small>{(archive.size / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Kio · prêt à être envoyé au serveur privé</small></div></div>}
      {importError && <Failure error={importError} />}
      <button className="connections-primary" onClick={() => void importArchive()} disabled={!archive || importing}>
        {importing ? <RefreshCw className="spinning" size={16} /> : <Upload size={16} />}{importing ? 'Vérification et import…' : 'Importer mes dossiers'}
      </button>
      <small className="connections-note">L’import commence uniquement après votre clic sur « Importer mes dossiers ».</small>
    </section>}
    {receipt && <div className="connections-success" role="status"><CheckCircle2 size={20} /><p>Import confirmé : {receipt.dossiers} dossiers et {receipt.enriched} fiches enrichies. Aucune écriture dans les sources externes.</p></div>}

    <section className="connections-sources" aria-labelledby="connections-sources-title">
      <h4 id="connections-sources-title">Vos sources</h4>
      {integrationError && !duplicateError && <Failure error={integrationError} />}
      {sheets && <article className="connections-source">
        <div className="connections-source-heading"><div className="connections-provider-icon"><Database size={23} /></div><div><h5>Google Sheets</h5><p>Source principale · lecture seule</p></div><ProviderBadge {...sheets} /></div>
        <p>{sheets.configured ? 'Les paramètres de lecture sont présents sur le serveur. Le contrôle lit la feuille et compare ses valeurs à l’archive, sans appliquer les différences.' : 'La connexion de lecture doit être configurée sur le serveur. Aucune clé n’est demandée dans le navigateur.'}</p>
        <dl className="connections-provider-details"><div><dt>Paramètres serveur</dt><dd>{sheets.configured ? 'Configurés' : 'À configurer'}</dd></div>
          <div><dt>Connexion à la source</dt><dd>{sheets.connected && sheets.checked ? 'Lecture réussie' : sheets.checked ? 'Lecture non aboutie' : 'Pas encore vérifiée'}</dd></div>
          {sheets.lastReadAt && <div><dt>Dernière lecture réussie</dt><dd>{formatDate(sheets.lastReadAt)}</dd></div>}
        </dl>
        {sheets.error && <p className="connections-source-warning">{messageFor(sheets.error)}</p>}
        {integrations?.automaticIntervalMinutes === 5 && <p className="connections-automatic">Lecture automatique toutes les 5 minutes. Les différences sont proposées à la validation ; Google Sheets reste inchangé.</p>}
        <button className="connections-primary" disabled={!sheets.configured || previewing || loading || approving || !setup} onClick={() => void checkSheets()}>
          <RefreshCw size={16} className={previewing ? 'spinning' : ''} />{previewing ? 'Lecture et comparaison…' : 'Contrôler Google Sheets'}
        </button>
      </article>}
      {invoicing && <article className="connections-source connections-source-planned">
        <div className="connections-source-heading"><div className="connections-provider-icon"><FileJson size={23} /></div><div><h5>{invoicing.providerConfirmed ? 'VosFactures' : 'Facturation'}</h5><p>{invoicing.providerConfirmed ? 'Fournisseur confirmé' : 'VosFactures envisagé · fournisseur à confirmer'}</p></div><span className="connections-badge">Non connecté</span></div>
        <p>{invoicing.configured ? 'Les paramètres sont présents sur le serveur. La connexion à la facturation reste désactivée.' : 'La connexion à la facturation sera préparée après confirmation du fournisseur et de l’accès autorisé.'} Aucun encaissement n’est certifié par cette connexion.</p>
      </article>}
    </section>

    {previewError && previewError.code !== setupError?.code && previewError.code !== integrationError?.code && <Failure error={previewError} />}
    {approvalReceipt && <div className="connections-success" role="status"><CheckCircle2 size={20} /><p>Application confirmée au portail : {approvalReceipt.dossiers} dossiers et {approvalReceipt.enriched} fiches enrichies conservés. Google Sheets n’a pas été modifié. Les montants restent non vérifiés.</p></div>}
    {preview && <section className="connections-comparison" aria-labelledby="sheets-comparison-title">
      <div className="connections-section-title"><ShieldCheck size={22} /><div><h4 id="sheets-comparison-title">Contrôle de cohérence</h4><p>Lecture du {formatDate(preview.readAt)}</p></div></div>
      <div className="connections-comparison-summary"><strong>{previewApplied ? 'Écarts appliqués après votre confirmation' : preview.initialImport ? 'Aucune archive de comparaison disponible' : preview.changes.length ? `${preview.changes.length.toLocaleString('fr-FR')} écarts à examiner` : 'Aucun écart détecté'}</strong>
        <p>{preview.initialImport ? 'La source a été lue, mais aucune comparaison avec les dossiers privés n’est possible avant leur import.' : 'Les informations de Google Sheets sont comparées à l’archive privée.'} Aucun remplacement automatique n’a été effectué.</p>
      </div>
      {sourceUrl && <a className="connections-source-link" href={sourceUrl} target="_blank" rel="noopener noreferrer">Ouvrir la feuille source <ExternalLink size={14} /></a>}
      <p className="connections-range">Plage lue : <code>{preview.source.range}</code></p>
      {!!preview.changes.length && <>
        <div className="connections-differences">
          {displayedChanges.map(change => <article key={`${change.clientId}:${change.field}`} className="connections-difference">
            <div className="connections-difference-heading"><h5>{change.clientId} · {FIELD_LABELS[change.field]}</h5><span>{change.requiresIdentityReview ? 'Identité à vérifier' : 'À vérifier'}</span></div>
            <div className="connections-values"><div><span>Archive privée actuelle</span><p>{change.before || 'Non renseigné'}</p></div><div><span>Google Sheets · valeur lue</span><p>{change.proposed || 'Non renseigné'}</p></div></div>
            {change.field === 'finance' && <p className="connections-financial-warning">Information financière non vérifiée : cette lecture ne prouve aucun encaissement.</p>}
          </article>)}
        </div>
        <nav className="connections-pagination" aria-label="Pagination des écarts"><span>Page {page} sur {pageCount}</span><div>
          <button disabled={page === 1} onClick={() => setPage(value => value - 1)} aria-label="Écarts précédents"><ChevronLeft size={18} /></button>
          <button disabled={page === pageCount} onClick={() => setPage(value => value + 1)} aria-label="Écarts suivants"><ChevronRight size={18} /></button>
        </div></nav>
      </>}
      {identityReviewRequired && <p className="connections-validation-note"><LockKeyhole size={16} />Ces écarts concernent l’identité d’un dossier. Le rapprochement doit être vérifié manuellement avant toute application.</p>}
      {preview.requiresValidation && !preview.initialImport && !identityReviewRequired && !previewApplied && <div className="connections-approval">
        <label><input type="checkbox" checked={confirmed} disabled={approving || previewing || loading} onChange={event => setConfirmed(event.target.checked)} /><span>J’ai vérifié ces écarts et j’autorise leur application au portail.</span></label>
        <button className="connections-primary" onClick={() => void approvePreview()} disabled={!confirmed || approving || previewing || loading || !setup}>
          {approving ? <RefreshCw className="spinning" size={16} /> : <CheckCircle2 size={16} />}{approving ? 'Application en cours…' : 'Appliquer au portail'}
        </button>
      </div>}
      <p className="connections-validation-note"><LockKeyhole size={16} />Google Sheets reste inchangé. Les informations financières conservent leur statut non vérifié.</p>
    </section>}

    {!!links.length && <section className="connections-references"><h4>Vos feuilles de référence</h4>{links.map(link => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">{link.label}<ExternalLink size={14} /></a>)}</section>}
    <details className="connections-history"><summary>Dernières vérifications du portail</summary><dl>
      <div><dt>Dernière lecture de la source</dt><dd>{lastReadAt ? formatDate(lastReadAt) : 'Information non retrouvée'}</dd></div>
      <div><dt>Dernière réponse de l’API</dt><dd>{lastCheckedAt ? formatDate(lastCheckedAt) : 'Information non retrouvée'}</dd></div>
      <div><dt>Dernière tentative du navigateur</dt><dd>{lastAttemptAt ? formatDate(lastAttemptAt) : 'Information non retrouvée'}</dd></div>
    </dl></details>
    <p className="connections-privacy"><LockKeyhole size={15} />Les clés privées restent sur le serveur. Les données consultées ne sont pas enregistrées dans le stockage du navigateur.</p>
  </div>;
}
