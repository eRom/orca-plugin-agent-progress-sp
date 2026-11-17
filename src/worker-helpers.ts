// Fonctions pures du worker : résolution des chemins à ouvrir et lecture de la mémoire stockée.
import type { LedgerMemory } from './model/workstream'

/** Un workspace local listé : seuls l'identifiant et la racine comptent ici. */
type RootedWorkspace = { id: string; path: string }

/** Chemin relatif au workspace, ou null s'il en sort (ou s'il n'en désigne aucun fichier). */
export function relativeToRoot(root: string, path: string): string | null {
  const base = root.replace(/\/+$/, '')
  const relative = path.startsWith('/') ? (path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null) : path
  if (relative === null || relative === '') return null
  return relative.split('/').includes('..') ? null : relative
}

/**
 * Le workspace local qui porte ce chemin, et le chemin relatif à sa racine. Un chemin absolu est cherché dans le
 * workspace demandé d'abord, puis dans les autres (la racine la plus profonde d'abord) : le plan d'un worktree
 * vit souvent dans le checkout principal. Un chemin relatif ne vaut que pour le workspace demandé.
 */
export function resolveOpenTarget(
  rows: readonly RootedWorkspace[],
  workspaceId: string,
  path: string,
): { workspaceId: string; path: string } | null {
  const requested = rows.find((row) => row.id === workspaceId)
  if (!path.startsWith('/')) {
    const relative = requested ? relativeToRoot(requested.path, path) : null
    return requested && relative !== null ? { workspaceId, path: relative } : null
  }
  const others = rows.filter((row) => row.id !== workspaceId).sort((a, b) => b.path.length - a.path.length)
  for (const row of requested ? [requested, ...others] : others) {
    const relative = relativeToRoot(row.path, path)
    if (relative !== null) return { workspaceId: row.id, path: relative }
  }
  return null
}

/** Lit la mémoire stockée ; une valeur qui n'a pas la forme attendue est ignorée plutôt que propagée. */
export function parseMemory(value: unknown): LedgerMemory {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const memory: LedgerMemory = {}
  for (const [key, entry] of Object.entries(value)) {
    const candidate = entry as Partial<LedgerMemory[string]> | null
    if (
      candidate &&
      typeof candidate.projectKey === 'string' &&
      typeof candidate.total === 'number' &&
      typeof candidate.done === 'number' &&
      typeof candidate.lastSeenAt === 'number'
    ) {
      memory[key] = candidate as LedgerMemory[string]
    }
  }
  return memory
}
