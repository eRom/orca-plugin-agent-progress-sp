// Assemblage pur de l'instantané : ni Orca, ni disque. Le worker lui passe l'état qu'il a rassemblé.
import type { Workstream } from './model/workstream'
import type { AgentRow, ProjectAgent, ProjectView, ProjectWorkstream, RestingView, Snapshot } from './protocol'

export type WorkspaceMeta = { workspaceId: string; projectKey: string; name: string; branch: string | null; root: string }
/** Le workspace actif, tel que `workspace.readContext` ou `workspace.changed` le rend. */
export type FocusInfo = { workspaceId: string; displayName: string; branch: string | null }

const needsUser = (agent: AgentRow): boolean => agent.state === 'blocked' || agent.state === 'waiting'

/** Ceux qui attendent l'utilisateur d'abord, l'ordre d'origine ensuite (tri stable). */
function sortAgents<T extends AgentRow>(agents: readonly T[]): T[] {
  return [...agents].sort((a, b) => Number(needsUser(b)) - Number(needsUser(a)))
}

const byRecency = (a: Workstream, b: Workstream): number => b.lastMovedAt - a.lastMovedAt || a.key.localeCompare(b.key)

/**
 * Le chantier par défaut d'abord : celui dont le ledger est ouvert, le ledger le plus récemment écrit en tête ;
 * sans ledger, le plus récemment modifié ; à égalité, la clé.
 */
export function byDefaultOrder(a: Workstream, b: Workstream): number {
  const aLedger = a.ledgerUpdatedAt
  const bLedger = b.ledgerUpdatedAt
  if (aLedger !== null && bLedger === null) return -1
  if (aLedger === null && bLedger !== null) return 1
  if (aLedger !== null && bLedger !== null && aLedger !== bLedger) return bLedger - aLedger
  if (aLedger === null && a.lastMovedAt !== b.lastMovedAt) return b.lastMovedAt - a.lastMovedAt
  return a.key.localeCompare(b.key)
}

/** Une même clé peut exister dans plusieurs workspaces : celle au ledger ouvert gagne, puis la plus récente. */
const beats = (candidate: Workstream, current: Workstream): boolean => {
  const candidateHasLedger = candidate.ledgerUpdatedAt !== null
  if (candidateHasLedger !== (current.ledgerUpdatedAt !== null)) return candidateHasLedger
  return candidate.lastMovedAt > current.lastMovedAt
}

export function assembleSnapshot(input: {
  focus: FocusInfo | null
  workspaces: readonly WorkspaceMeta[]
  workstreams: Record<string, Workstream[]>
  agents: Record<string, AgentRow[]>
}): Snapshot {
  const restingCandidates: { meta: WorkspaceMeta; latest: Workstream }[] = []
  const metasByProject = new Map<string, WorkspaceMeta[]>()
  let anySuperpowers = false

  for (const meta of input.workspaces) {
    const group = metasByProject.get(meta.projectKey)
    if (group) group.push(meta)
    else metasByProject.set(meta.projectKey, [meta])
    const all = input.workstreams[meta.workspaceId] ?? []
    if (all.length > 0) anySuperpowers = true
    if (all.length > 0 && !all.some((workstream) => workstream.live)) restingCandidates.push({ meta, latest: [...all].sort(byRecency)[0] })
  }

  const live: ProjectView[] = []
  for (const [projectKey, metas] of metasByProject) {
    // Une instance par clé : le même document committé existe dans le checkout principal et dans chaque worktree.
    const byKey = new Map<string, ProjectWorkstream>()
    for (const meta of metas) {
      for (const workstream of input.workstreams[meta.workspaceId] ?? []) {
        if (!workstream.live) continue
        const current = byKey.get(workstream.key)
        if (!current || beats(workstream, current)) byKey.set(workstream.key, { ...workstream, workspaceId: meta.workspaceId, branch: meta.branch })
      }
    }
    if (byKey.size === 0) continue
    const agents: ProjectAgent[] = metas.flatMap((meta) =>
      (input.agents[meta.workspaceId] ?? []).map((agent) => ({ ...agent, workspaceId: meta.workspaceId, location: meta.branch ?? meta.name })),
    )
    live.push({
      projectKey,
      name: metas[0].name,
      workstreams: [...byKey.values()].sort(byDefaultOrder),
      agents: sortAgents(agents),
      needsYou: agents.some(needsUser),
    })
  }

  const latestMove = (view: ProjectView): number => Math.max(...view.workstreams.map((item) => item.lastMovedAt))
  live.sort((a, b) => latestMove(b) - latestMove(a) || a.name.localeCompare(b.name))

  // Le checkout principal d'un plan exécuté dans un worktree n'est pas « au repos » : le chantier vit ailleurs dans le projet.
  const projectsWithLiveWork = new Set(live.map((view) => view.projectKey))
  const resting: RestingView[] = restingCandidates
    .filter(({ meta }) => !projectsWithLiveWork.has(meta.projectKey))
    .map(({ meta, latest }) => ({ workspaceId: meta.workspaceId, name: meta.name, lastDoc: latest.label, lastMovedAt: latest.lastMovedAt }))
    .sort((a, b) => b.lastMovedAt - a.lastMovedAt || a.name.localeCompare(b.name))

  const listed = input.focus ? input.workspaces.find((meta) => meta.workspaceId === input.focus?.workspaceId) : undefined
  const focused = input.focus
    ? {
        workspaceId: input.focus.workspaceId,
        name: listed?.name ?? input.focus.displayName,
        branch: listed ? listed.branch : input.focus.branch,
      }
    : null

  const localRoots = [...new Set(input.workspaces.map((meta) => meta.root))].sort()

  return {
    focusedWorkspaceId: focused?.workspaceId ?? null,
    focusedProjectKey: listed?.projectKey ?? null,
    focused,
    live,
    resting,
    anySuperpowers,
    localRoots,
  }
}
