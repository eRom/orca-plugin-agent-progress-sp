// Assemblage pur de l'instantané : ni Orca, ni disque. Le worker lui passe l'état qu'il a rassemblé.
import type { Workstream } from './model/workstream'
import type { AgentRow, RestingView, Snapshot, WorkspaceView } from './protocol'

export type WorkspaceMeta = { workspaceId: string; projectKey: string; name: string; branch: string | null; root: string }
/** Le workspace actif, tel que `workspace.readContext` ou `workspace.changed` le rend. */
export type FocusInfo = { workspaceId: string; displayName: string; branch: string | null }

const needsUser = (agent: AgentRow): boolean => agent.state === 'blocked' || agent.state === 'waiting'

/** Ceux qui attendent l'utilisateur d'abord, l'ordre d'origine ensuite (tri stable). */
function sortAgents(agents: readonly AgentRow[]): AgentRow[] {
  return [...agents].sort((a, b) => Number(needsUser(b)) - Number(needsUser(a)))
}

const byRecency = (a: Workstream, b: Workstream): number => b.lastMovedAt - a.lastMovedAt || a.key.localeCompare(b.key)

export function assembleSnapshot(input: {
  focus: FocusInfo | null
  workspaces: readonly WorkspaceMeta[]
  workstreams: Record<string, Workstream[]>
  agents: Record<string, AgentRow[]>
}): Snapshot {
  const live: WorkspaceView[] = []
  const restingCandidates: { meta: WorkspaceMeta; latest: Workstream }[] = []
  const projectsWithLiveWork = new Set<string>()
  let anySuperpowers = false

  for (const meta of input.workspaces) {
    const all = input.workstreams[meta.workspaceId] ?? []
    if (all.length > 0) anySuperpowers = true
    const alive = all.filter((workstream) => workstream.live).sort(byRecency)
    if (alive.length > 0) {
      projectsWithLiveWork.add(meta.projectKey)
      const agents = sortAgents(input.agents[meta.workspaceId] ?? [])
      live.push({
        workspaceId: meta.workspaceId,
        name: meta.name,
        branch: meta.branch,
        root: meta.root,
        workstreams: alive,
        agents,
        needsYou: agents.some(needsUser),
      })
    } else if (all.length > 0) {
      restingCandidates.push({ meta, latest: [...all].sort(byRecency)[0] })
    }
  }

  live.sort((a, b) => b.workstreams[0].lastMovedAt - a.workstreams[0].lastMovedAt || a.name.localeCompare(b.name))

  // Le checkout principal d'un plan exécuté dans un worktree n'est pas « au repos » : le chantier vit ailleurs dans le projet.
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

  return { focusedWorkspaceId: focused?.workspaceId ?? null, focused, live, resting, anySuperpowers }
}
