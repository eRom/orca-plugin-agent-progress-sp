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
  const finite = (field: unknown): field is number => typeof field === 'number' && Number.isFinite(field)
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.projectKey !== 'string' || !finite(candidate.total) || !finite(candidate.done) || !finite(candidate.lastSeenAt)) continue
    // `goneAt` présent mais illisible : l'entrée est écartée, sinon un Done s'afficherait sur une date fausse.
    if ('goneAt' in candidate && !finite(candidate.goneAt)) continue
    // `workspaceId` est absent des entrées écrites avant ce champ : c'est permis.
    if ('workspaceId' in candidate && typeof candidate.workspaceId !== 'string') continue
    memory[key] = {
      projectKey: candidate.projectKey,
      total: candidate.total,
      done: candidate.done,
      lastSeenAt: candidate.lastSeenAt,
      ...('goneAt' in candidate ? { goneAt: candidate.goneAt as number } : {}),
      ...('workspaceId' in candidate ? { workspaceId: candidate.workspaceId as string } : {}),
    }
  }
  return memory
}
