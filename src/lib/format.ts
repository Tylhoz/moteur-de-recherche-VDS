export const euro = (value: number, compact = false) =>
  new Intl.NumberFormat('fr-BE', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: compact ? 0 : 2,
    ...(compact ? { notation: 'compact' as const } : {}),
  }).format(value);
export const dateLabel = (value: string) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(
        new Date(value + (value.length === 10 ? 'T12:00:00' : '')),
      )
    : 'À planifier';
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
export const categoryLabel = {
  alerte: 'À vérifier',
  solde: 'À suivre',
  sav: 'SAV & pose',
  valide: 'Classé validé',
  non_verifie: 'Non vérifié',
} as const;
