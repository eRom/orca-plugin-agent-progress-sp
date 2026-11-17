// Contrat panneau <-> worker, déclaré une fois : le worker (src/worker.ts) et le panneau le lisent.
import type { Workstream } from './model/workstream'

/** Un agent d'un workspace, tel que `agents.list` le rend. `since` = début de l'état courant (ms epoch). */
export type AgentRow = {
  terminalId: string | null
  agent: string | null
  state: 'working' | 'blocked' | 'waiting' | 'done'
  since: number
}

/** Un workspace local qui a au moins un chantier vivant. */
export type WorkspaceView = {
  workspaceId: string
  name: string
  branch: string | null
  root: string
  /** Chantiers vivants, le plus récemment modifié d'abord. */
  workstreams: Workstream[]
  /** Agents du workspace, ceux qui attendent l'utilisateur d'abord. */
  agents: AgentRow[]
  /** Un agent est `blocked` ou `waiting`. */
  needsYou: boolean
}

/** Un workspace qui a des fichiers Superpowers mais aucun chantier vivant. */
export type RestingView = { workspaceId: string; name: string; lastDoc: string; lastMovedAt: number }

export type Snapshot = {
  focusedWorkspaceId: string | null
  /** Pour l'en-tête du panneau, même sans chantier vivant. */
  focused: { workspaceId: string; name: string; branch: string | null } | null
  live: WorkspaceView[]
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
