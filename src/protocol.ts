// Contrat panneau <-> worker, déclaré une fois : le worker (src/worker.ts) et le panneau le lisent.
import type { Workstream } from './model/workstream'

/** Un agent d'un workspace, tel que `agents.list` le rend. `since` = début de l'état courant (ms epoch). */
export type AgentRow = {
  terminalId: string | null
  agent: string | null
  state: 'working' | 'blocked' | 'waiting' | 'done'
  since: number
}

/** Un agent du projet, avec le workspace de son terminal ; `location` = branche de ce workspace, sinon son nom. */
export type ProjectAgent = AgentRow & { workspaceId: string; location: string }

/** Un chantier vivant, avec le workspace qui le porte. */
export type ProjectWorkstream = Workstream & { workspaceId: string; branch: string | null }

/** Un projet (checkout principal et worktrees confondus) qui a au moins un chantier vivant. */
export type ProjectView = {
  projectKey: string
  name: string
  /** Chantiers vivants de tous ses workspaces, le chantier par défaut d'abord (`byDefaultOrder`). */
  workstreams: ProjectWorkstream[]
  /** Agents de tous ses workspaces, ceux qui attendent l'utilisateur d'abord. */
  agents: ProjectAgent[]
  /** Un agent est `blocked` ou `waiting`. */
  needsYou: boolean
}

/** Un workspace qui a des fichiers Superpowers mais aucun chantier vivant. */
export type RestingView = { workspaceId: string; name: string; lastDoc: string; lastMovedAt: number }

export type Snapshot = {
  focusedWorkspaceId: string | null
  /** Projet du workspace actif s'il est listé, sinon null. */
  focusedProjectKey: string | null
  /** Pour l'en-tête du panneau, même sans chantier vivant. */
  focused: { workspaceId: string; name: string; branch: string | null } | null
  live: ProjectView[]
  resting: RestingView[]
  /** Au moins un workspace a des fichiers Superpowers. */
  anySuperpowers: boolean
  /** Racines des workspaces locaux listés : le panneau n'affiche un bouton de document que sous l'une d'elles. */
  localRoots: string[]
}

declare module 'orca' {
  interface PluginRequests {
    /** Le dernier instantané du worker. */
    'progress.snapshot': { output: Snapshot }
    /** Ouvre un document dans un onglet d'Orca ; `opened: false` si le chemin sort du workspace. */
    'progress.openFile': { input: { workspaceId: string; path: string }; output: { opened: boolean } }
    /** Amène le terminal d'un agent au premier plan. */
    'progress.focusTerminal': { input: { terminalId: string }; output: { focused: boolean } }
    /** Amène Orca sur un workspace. */
    'progress.openWorkspace': { input: { workspaceId: string }; output: { opened: boolean } }
  }
  interface PluginPanelEvents {
    /** Posté à chaque panneau ouvert dès que l'instantané change ou que le focus bouge. */
    'progress.changed': Snapshot
  }
}
