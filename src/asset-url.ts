/** Resolve runtime files beneath the Vite base, including GitHub project Pages. */
export function assetUrl(path: string): string {
  return `${import.meta.env?.BASE_URL ?? '/'}${path.replace(/^\/+/, '')}`;
}
