// Le worker du plugin : relit les fichiers Superpowers des workspaces locaux toutes les 3 s, tient l'instantané,
// les agents et la mémoire des ledgers, puis alimente le panneau et la barre d'état.
import type { OrcaWorkerApi } from 'orca/worker'
import {
  buildProject,
  externalPointers,
  sameMemory,
  type DocFile,
  type LedgerMemory,
  type Workstream,
  type WorkspaceInput,
} from './model/workstream'
import type { AgentRow, Snapshot } from './protocol'
import { createScanner } from './scan'
import { assembleSnapshot, type FocusInfo, type WorkspaceMeta } from './snapshot'
import { statusBarFor } from './status-bar'
import { labelOf, parseMemory, resolveOpenTarget } from './worker-helpers'

export const TICK_MS = 3000
/** `workspace.list` est relu au premier tour, puis tous les 9 tours (27 s : un nouveau workspace apparaît en moins de 30 s). */
const LIST_EVERY_TICKS = 9
const LOG_EVERY_TICKS = 20
const EXTERNAL_PASSES = 3
const MEMORY_KEY = 'ledgerMemory'
const STATUS_ITEM = 'progress'

type Scanner = ReturnType<typeof createScanner>
type Schedule = (fn: () => void, ms: number) => () => void

export type ProgressDeps = { scanner?: Scanner; now?: () => number; schedule?: Schedule }
export type ProgressWorker = { tick(): Promise<void>; stop(): void }

/** Ce que le worker garde d'une ligne de `workspace.list` : locale, avec un chemin. */
type ListedWorkspace = { id: string; name: string; projectKey: string; path: string; branch: string | null }

const realSchedule: Schedule = (fn, ms) => {
  const handle = setTimeout(fn, ms)
  return () => clearTimeout(handle)
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createProgressWorker(orca: OrcaWorkerApi, deps: ProgressDeps = {}): ProgressWorker {
  const scanner = deps.scanner ?? createScanner()
  const now = deps.now ?? Date.now
  const schedule = deps.schedule ?? realSchedule

  let memory: LedgerMemory = {}
  let persistedMemory: LedgerMemory = {}
  /** Vrai dès qu'une lecture du stockage a réussi ; l'écriture de la mémoire attend ce moment. */
  let memoryRead = false
  let rows: ListedWorkspace[] = []
  let listDue = true
  let focus: FocusInfo | null = null
  // Un `workspace.changed` plus récent que `readContext` l'emporte sur lui.
  let focusFromEvent = false
  let contextRead = false
  const projectResults = new Map<string, Record<string, Workstream[]>>()
  const agentsByWorkspace = new Map<string, AgentRow[]>()
  const paneStates = new Map<string, string>()
  let lastJson: string | null = null
  let tickCount = 0
  let durations: number[] = []
  let inFlight: Promise<void> | null = null
  let hasTicked = false
  let stopped = false
  let cancelNext: (() => void) | null = null

  const log = (message: string): void => orca.log(message)

  // ---------------------------------------------------------------------------------------------
  // Instantané et diffusion
  // ---------------------------------------------------------------------------------------------

  function rebuild(): Snapshot {
    const workstreams: Record<string, Workstream[]> = {}
    for (const result of projectResults.values()) Object.assign(workstreams, result)
    const workspaces: WorkspaceMeta[] = rows.map((row) => ({
      workspaceId: row.id,
      projectKey: row.projectKey,
      name: row.name,
      branch: row.branch,
      root: row.path,
    }))
    return assembleSnapshot({ focus, workspaces, workstreams, agents: Object.fromEntries(agentsByWorkspace) })
  }

  /** Poste l'instantané et met la barre d'état à jour, seulement s'il a changé (focus compris : il en fait partie). */
  async function publish(): Promise<void> {
    const snapshot = rebuild()
    const json = JSON.stringify(snapshot)
    if (json === lastJson) return
    lastJson = json
    orca.panels.post('progress.changed', snapshot)
    const bar = statusBarFor(snapshot)
    try {
      await orca.host.call('statusBar.update', bar.visible ? { id: STATUS_ITEM, ...bar } : { id: STATUS_ITEM, visible: false })
    } catch (error) {
      log(`statusBar.update failed: ${messageOf(error)}`)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------------------------

  /** Workspaces dont on suit les agents : ceux qui ont un chantier vivant, et le workspace actif. */
  function neededAgentWorkspaces(): Set<string> {
    const needed = new Set<string>()
    for (const row of rows) {
      const result = projectResults.get(row.projectKey)?.[row.id]
      if (result?.some((workstream) => workstream.live)) needed.add(row.id)
    }
    if (focus && rows.some((row) => row.id === focus?.workspaceId)) needed.add(focus.workspaceId)
    return needed
  }

  async function refreshAgents(workspaceId: string): Promise<void> {
    try {
      const { agents } = await orca.host.call('agents.list', { workspaceId })
      agentsByWorkspace.set(
        workspaceId,
        agents.map((agent) => ({ terminalId: agent.terminalId, agent: agent.agent, state: agent.state, since: agent.stateStartedAt })),
      )
    } catch (error) {
      // Liste vide plutôt que ré-essai à chaque tour : un événement d'agent ou une sortie de la vue relance l'appel.
      agentsByWorkspace.set(workspaceId, [])
      log(`agents.list failed for ${workspaceId}: ${messageOf(error)}`)
    }
  }

  /**
   * Liste les agents des workspaces qui entrent dans la vue, oublie ceux qui en sortent, et relit ceux que `refresh` désigne.
   * Orca n'émet aucun `agent.status.changed` quand un terminal est fermé : sans relecture, un agent `waiting` fantôme resterait.
   */
  async function syncAgents(refresh: (workspaceId: string) => boolean = () => false): Promise<void> {
    const needed = neededAgentWorkspaces()
    for (const id of [...agentsByWorkspace.keys()]) if (!needed.has(id)) agentsByWorkspace.delete(id)
    await Promise.all([...needed].filter((id) => !agentsByWorkspace.has(id) || refresh(id)).map(refreshAgents))
  }

  // ---------------------------------------------------------------------------------------------
  // Un tour
  // ---------------------------------------------------------------------------------------------

  async function refreshList(): Promise<void> {
    listDue = false
    try {
      const { workspaces } = await orca.host.call('workspace.list')
      rows = workspaces
        // Local seulement : ni SSH ni runtime, et un dossier sans chemin n'a rien à lire.
        .filter((workspace) => (workspace.hostId === null || workspace.hostId === 'local') && workspace.path.trim() !== '')
        .map((workspace) => ({
          id: workspace.id,
          name: labelOf(workspace),
          projectKey: workspace.projectId ?? workspace.id,
          path: workspace.path,
          branch: workspace.branch,
        }))
    } catch (error) {
      log(`workspace.list failed: ${messageOf(error)}`)
    }
  }

  async function readInitialContext(): Promise<void> {
    contextRead = true
    try {
      const context = await orca.host.call('workspace.readContext')
      if (!focusFromEvent) focus = focusOf(context)
    } catch (error) {
      log(`workspace.readContext failed: ${messageOf(error)}`)
    }
  }

  /** Lit tous les workspaces d'un projet, puis les documents externes qu'ils désignent. Null si une lecture lève. */
  async function scanProject(
    projectKey: string,
    members: ListedWorkspace[],
  ): Promise<{ projectKey: string; inputs: WorkspaceInput[]; external: Record<string, DocFile> } | null> {
    try {
      const inputs = await Promise.all(
        members.map(async (member) => ({
          workspaceId: member.id,
          projectKey,
          root: member.path,
          files: await scanner.scanWorkspace(member.path),
        })),
      )
      const roots = members.map((member) => member.path)
      const external: Record<string, DocFile> = {}
      // Le plan lu mène à sa spec, la spec à son intent : jusqu'à 3 passes, à chaque tour, pour que la clé d'un chantier soit stable.
      for (let pass = 0; pass < EXTERNAL_PASSES; pass++) {
        const wanted = new Set<string>()
        for (const input of inputs) for (const path of externalPointers(input.files, roots, external)) wanted.add(path)
        if (wanted.size === 0) break
        const found = await scanner.readExternal([...wanted])
        if (Object.keys(found).length === 0) break
        Object.assign(external, found)
      }
      return { projectKey, inputs, external }
    } catch (error) {
      log(`scan failed for project ${projectKey}: ${messageOf(error)}`)
      return null
    }
  }

  async function runTick(): Promise<void> {
    const startedAt = now()
    if (!memoryRead) {
      // Tant que la lecture échoue on travaille sur une mémoire vide et on n'écrit rien : écrire effacerait les `goneAt` stockés.
      try {
        memory = parseMemory(await orca.storage.get(MEMORY_KEY))
        persistedMemory = memory
        memoryRead = true
      } catch (error) {
        log(`storage.get failed: ${messageOf(error)}`)
      }
    }
    if (!contextRead) await readInitialContext()
    if (listDue || tickCount % LIST_EVERY_TICKS === 0) await refreshList()

    const groups = new Map<string, ListedWorkspace[]>()
    for (const row of rows) {
      const group = groups.get(row.projectKey)
      if (group) group.push(row)
      else groups.set(row.projectKey, [row])
    }
    for (const key of [...projectResults.keys()]) if (!groups.has(key)) projectResults.delete(key)

    const scans = await Promise.all([...groups].map(([projectKey, members]) => scanProject(projectKey, members)))
    // Un projet dont la lecture a levé garde son résultat du tour précédent, et sa mémoire n'est pas touchée.
    for (const scan of scans) {
      if (!scan) continue
      const built = buildProject({ workspaces: scan.inputs, external: scan.external, memory, now: now() })
      memory = built.memory
      projectResults.set(scan.projectKey, built.byWorkspace)
    }
    if (memoryRead && !sameMemory(persistedMemory, memory)) {
      try {
        await orca.storage.set(MEMORY_KEY, memory)
        persistedMemory = memory
      } catch (error) {
        log(`storage.set failed: ${messageOf(error)}`)
      }
    }

    // Toutes les 9 tours, les agents déjà suivis sont relus : un terminal fermé disparaît au plus tard après ~27 s.
    await syncAgents(() => tickCount % LIST_EVERY_TICKS === 0)
    await publish()

    durations.push(now() - startedAt)
    if (durations.length >= LOG_EVERY_TICKS) {
      const sorted = [...durations].sort((a, b) => a - b)
      log(`tick p50=${sorted[Math.floor(sorted.length / 2)]}ms max=${sorted[sorted.length - 1]}ms over ${sorted.length}`)
      durations = []
    }
  }

  /** Un tour ne lève jamais ; deux appels simultanés partagent le même tour ; le suivant est armé à la fin. */
  function tick(): Promise<void> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        await runTick()
      } catch (error) {
        log(`tick failed: ${messageOf(error)}`)
      } finally {
        hasTicked = true
        tickCount++
        inFlight = null
        cancelNext?.()
        cancelNext = stopped ? null : schedule(() => void tick(), TICK_MS)
      }
    })()
    return inFlight
  }

  // ---------------------------------------------------------------------------------------------
  // Événements, requêtes, commande
  // ---------------------------------------------------------------------------------------------

  const disposables = [
    orca.events.on('workspace.changed', async (payload) => {
      try {
        focus = focusOf(payload.context)
        focusFromEvent = true
        listDue = true
        // Avant la fin du premier tour l'état est vide : le premier tour publie lui-même, un instantané vide ferait clignoter le panneau.
        if (!hasTicked) return
        // Ouverture, fermeture ou renommage d'un terminal : on relit les agents du workspace actif, même déjà suivi.
        const focusedId = focus?.workspaceId
        if (focusedId && rows.some((row) => row.id === focusedId)) await syncAgents((id) => id === focusedId)
        await publish()
      } catch (error) {
        log(`workspace.changed failed: ${messageOf(error)}`)
      }
    }),

    orca.events.on('agent.status.changed', async (payload) => {
      try {
        // On ne relit les agents que si l'état de ce panneau a vraiment changé (la sonde a reçu 70 « working » identiques en 4 minutes).
        if (paneStates.get(payload.paneKey) === payload.state) return
        paneStates.set(payload.paneKey, payload.state)
        const workspaceId = payload.workspaceListId
        if (!workspaceId || !agentsByWorkspace.has(workspaceId)) return
        await refreshAgents(workspaceId)
        if (hasTicked) await publish()
      } catch (error) {
        log(`agent.status.changed failed: ${messageOf(error)}`)
      }
    }),

    orca.panels.handle('progress.snapshot', async () => {
      if (!hasTicked) await tick()
      return rebuild()
    }),

    orca.panels.handle('progress.openFile', async ({ workspaceId, path }) => {
      const target = resolveOpenTarget(rows, workspaceId, path)
      if (!target) return { opened: false }
      await orca.host.call('editor.open', target)
      return { opened: true }
    }),

    orca.panels.handle('progress.focusTerminal', async ({ terminalId }) => {
      if (!orca.host.has('terminal.focus')) return { focused: false }
      const { focused } = await orca.host.call('terminal.focus', { terminalId })
      return { focused }
    }),

    orca.panels.handle('progress.openWorkspace', async ({ workspaceId }) => {
      await orca.host.call('workspace.open', { workspaceId })
      return { opened: true }
    }),

    // Aucun plugin ne peut ouvrir son panneau : le clic ouvre la barre latérale droite.
    orca.commands.register('progress.toggle', async () => {
      await orca.host.call('commands.run', { action: 'sidebar.right.toggle' })
    }),
  ]

  return {
    tick,
    stop() {
      stopped = true
      cancelNext?.()
      cancelNext = null
      for (const disposable of disposables) disposable.dispose()
    },
  }
}

/** Le focus d'un contexte Orca ; sans `workspaceId`, on ne peut pas dire quel workspace est actif. */
function focusOf(context: { workspaceId?: string; branch: string; displayName: string } | null): FocusInfo | null {
  if (!context || !context.workspaceId) return null
  return { workspaceId: context.workspaceId, displayName: context.displayName, branch: context.branch }
}

// ---------------------------------------------------------------------------------------------
// Cycle de vie Orca
// ---------------------------------------------------------------------------------------------

let active: ProgressWorker | null = null

export default function activate(orca: OrcaWorkerApi): void {
  active = createProgressWorker(orca)
  void active.tick()
}

export function deactivate(): void {
  active?.stop()
  active = null
}
