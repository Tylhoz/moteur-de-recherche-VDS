/// <reference types="vite/client" />

// The original brand asset is bundled by Vite when it is available. No remote
// URL or generated substitute is used; absence keeps a readable wordmark.
const originalAssets = import.meta.glob('../assets/vds-pools-logo.{png,jpg,jpeg,webp,svg}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const originalLogo = Object.keys(originalAssets).sort().map(key => originalAssets[key])[0];

export default function BrandLogo() {
  return originalLogo ? (
    <span className="vds-original-logo">
      <img src={originalLogo} alt="VDS Pools" width={1946} height={1326} decoding="async" />
    </span>
  ) : (
    <span className="vds-brand-wordmark" aria-label="VDS Pools">
      <strong>VDS</strong><span>POOLS</span>
    </span>
  );
}
