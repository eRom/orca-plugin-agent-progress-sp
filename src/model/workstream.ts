// Assemblage des workstreams : pur, sans import Node ni Orca. `now` est toujours passé par l'appelant.
// Un chantier est une chaîne de documents reliés par des pointeurs explicites (ledger -> plan -> spec -> intent).

import { docLabel, fileDate, parsePlanTasks, planSpecPointer, repoRootOf, specIntentPointer } from './docs'
import { parseLedger, type LedgerRead } from './ledger'

export type DocFile = { path: string; text: string; mtimeMs: number }
export type WorkspaceFiles = { intents: DocFile[]; specs: DocFile[]; plans: DocFile[]; ledgers: DocFile[] }
export type WorkspaceInput = { workspaceId: string; projectKey: string; root: string; files: WorkspaceFiles }
export type Stage = 'intent' | 'spec' | 'plan' | 'tasks' | 'review' | 'done'
export type TaskRow = {
  id: string
  title: string
  status: 'done' | 'todo' | 'in-progress' | 'fix'
  fix?: { round: number; max: number }
}
export type Workstream = {
  key: string
  label: string
  stage: Stage
  hasIntent: boolean
  /** Étapes absentes d'un chantier commencé plus loin ; le panneau les affiche atténuées, sans coche. */
  skippedStages: Stage[]
  /** Chemins absolus. */
  docs: { intent?: string; spec?: string; plan?: string; ledger?: string }
  tasks: TaskRow[]
  tasksDone: number
  tasksTotal: number
  unparsedLines: number
  notes: string[]
  lastMovedAt: number
  /** mtimeMs du ledger présent, sinon null. */
  ledgerUpdatedAt: number | null
  live: boolean
}
export type LedgerMemoryEntry = { projectKey: string; total: number; done: number; lastSeenAt: number; goneAt?: number }
/** Clé = `Workstream.key`. */
export type LedgerMemory = Record<string, LedgerMemoryEntry>

export const LIVE_WINDOW_MS = 604_800_000
const MEMORY_RETENTION_MS = 30 * 86_400_000
const DOC_DIR = 'docs/superpowers'

// Dossiers où chercher « le même nom de fichier » quand un chemin absolu ne mène nulle part.
const PLAN_FOLDERS = ['plans']
const SPEC_FOLDERS = ['specs', 'intents']
const INTENT_FOLDERS = ['intents']

// ---------------------------------------------------------------------------------------------
// Chemins et résolution des pointeurs
// ---------------------------------------------------------------------------------------------

/** Un document retrouvé : `ws` est le workspace du projet qui le porte, null s'il vient de `external`. */
type Located = { file: DocFile; ws: WorkspaceInput | null }

type Context = {
  projectKey: string
  workspaces: WorkspaceInput[]
  /** workspaceId -> chemin relatif à la racine -> fichier (intents, specs, plans). */
  index: Map<string, Map<string, DocFile>>
  external: Record<string, DocFile>
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function stripTrailingSlash(root: string): string {
  return root.length > 1 ? root.replace(/\/+$/, '') : root
}

function relativeTo(root: string, path: string): string | null {
  const prefix = `${stripTrailingSlash(root)}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : null
}

/** Workspace du projet dont la racine contient ce chemin (la plus profonde gagne). */
function ownerOf(ctx: Context, path: string): WorkspaceInput | null {
  let best: WorkspaceInput | null = null
  for (const ws of ctx.workspaces) {
    if (relativeTo(ws.root, path) === null) continue
    if (best === null || ws.root.length > best.root.length) best = ws
  }
  return best
}

function buildContext(projectKey: string, workspaces: WorkspaceInput[], external: Record<string, DocFile>): Context {
  const index = new Map<string, Map<string, DocFile>>()
  for (const ws of workspaces) {
    const byRel = new Map<string, DocFile>()
    for (const file of [...ws.files.intents, ...ws.files.specs, ...ws.files.plans]) {
      byRel.set(relativeTo(ws.root, file.path) ?? file.path, file)
    }
    index.set(ws.workspaceId, byRel)
  }
  return { projectKey, workspaces, index, external }
}

/**
 * Pointeur -> document. Relatif : contre la racine du document qui le porte. Absolu sous la racine d'un
 * workspace du projet : lu dans les fichiers de ce workspace. Absolu ailleurs : `external`, puis le même nom
 * de fichier dans le dossier correspondant du workspace d'origine (`home`). Sinon null.
 */
function resolvePointer(
  ctx: Context,
  pointer: string,
  carrierPath: string,
  home: WorkspaceInput,
  folders: readonly string[],
): Located | null {
  let abs = pointer
  if (!pointer.startsWith('/')) {
    const base = ownerOf(ctx, carrierPath)?.root ?? repoRootOf(carrierPath)
    if (base === null) return null
    abs = `${stripTrailingSlash(base)}/${pointer}`
  }
  const owner = ownerOf(ctx, abs)
  if (owner) {
    const rel = relativeTo(owner.root, abs)
    const file = rel === null ? undefined : ctx.index.get(owner.workspaceId)?.get(rel)
    if (file) return { file, ws: owner }
  }
  const external = ctx.external[abs]
  if (external) return { file: external, ws: null }
  const name = baseName(abs)
  for (const folder of folders) {
    const file = ctx.index.get(home.workspaceId)?.get(`${DOC_DIR}/${folder}/${name}`)
    if (file) return { file, ws: home }
  }
  return null
}

/** Identité d'un document dans le projet : sa clé de chantier s'il en ouvre un. */
function idOf(ctx: Context, located: Located): string {
  if (located.ws === null) return `abs:${located.file.path}`
  return `${ctx.projectKey}:${relativeTo(located.ws.root, located.file.path) ?? located.file.path}`
}

// ---------------------------------------------------------------------------------------------
// Chemins désignés hors du projet
// ---------------------------------------------------------------------------------------------

type PointerKind = 'ledger' | 'plan' | 'spec'

function kindOfPath(path: string): PointerKind | null {
  if (path.includes('/.superpowers/sdd/')) return 'ledger'
  if (path.includes(`/${DOC_DIR}/plans/`)) return 'plan'
  if (path.includes(`/${DOC_DIR}/specs/`) || path.includes(`/${DOC_DIR}/intents/`)) return 'spec'
  return null
}

function pointerOf(kind: PointerKind, text: string): string | null {
  if (kind === 'ledger') return parseLedger(text).planPath
  if (kind === 'plan') return planSpecPointer(text)
  return specIntentPointer(text)
}

function underAnyRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => relativeTo(root, path) !== null)
}

/**
 * Chemins absolus situés hors de toutes les racines du projet que les ledgers, plans et specs désignent
 * (ceux du workspace, et ceux des documents externes déjà lus dans `known`), et qui ne sont pas encore connus.
 * Le worker les lit, puis rappelle : le plan lu mène à sa spec, la spec à son intent.
 */
export function externalPointers(
  files: WorkspaceFiles,
  projectRoots: readonly string[],
  known: Record<string, DocFile>,
): string[] {
  const found: string[] = []
  const consider = (kind: PointerKind, doc: DocFile) => {
    const pointer = pointerOf(kind, doc.text)
    if (pointer === null) return
    let abs = pointer
    if (!pointer.startsWith('/')) {
      const base = repoRootOf(doc.path)
      if (base === null) return
      abs = `${base}/${pointer}`
    }
    if (underAnyRoot(abs, projectRoots) || abs in known || found.includes(abs)) return
    found.push(abs)
  }
  for (const doc of files.ledgers) consider('ledger', doc)
  for (const doc of files.plans) consider('plan', doc)
  for (const doc of [...files.specs, ...files.intents]) consider('spec', doc)
  for (const doc of Object.values(known)) {
    const kind = kindOfPath(doc.path)
    if (kind !== null) consider(kind, doc)
  }
  return found
}

// ---------------------------------------------------------------------------------------------
// Instances : un chantier tel qu'il se montre dans un workspace
// ---------------------------------------------------------------------------------------------

type Instance = {
  key: string
  ws: WorkspaceInput
  ledger: { file: DocFile; read: LedgerRead } | null
  plan: Located | null
  spec: Located | null
  intent: Located | null
}

function linkSpecAndIntent(ctx: Context, instance: Instance): void {
  if (instance.plan && !instance.spec) {
    const pointer = planSpecPointer(instance.plan.file.text)
    if (pointer !== null) {
      instance.spec = resolvePointer(ctx, pointer, instance.plan.file.path, instance.ws, SPEC_FOLDERS)
    }
  }
  if (instance.spec && !instance.intent) {
    const pointer = specIntentPointer(instance.spec.file.text)
    if (pointer !== null) {
      instance.intent = resolvePointer(ctx, pointer, instance.spec.file.path, instance.ws, INTENT_FOLDERS)
    }
  }
}

function ledgerOnlyKey(ctx: Context, ws: WorkspaceInput, ledger: DocFile): string {
  return `${ctx.projectKey}:${relativeTo(ws.root, ledger.path) ?? ledger.path}`
}

function buildInstances(ctx: Context): Instance[] {
  const instances: Instance[] = []
  const ledgerKeys = new Set<string>()
  const taken = new Set<string>()
  const add = (instance: Instance) => {
    const slot = `${instance.key}|${instance.ws.workspaceId}`
    if (taken.has(slot)) return
    taken.add(slot)
    instances.push(instance)
  }

  // 1. Ledgers : le plus récent par (clé, workspace) l'emporte.
  const ledgerInstances: Instance[] = []
  for (const ws of ctx.workspaces) {
    const byRecency = [...ws.files.ledgers].sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const file of byRecency) {
      const read = parseLedger(file.text)
      const plan = read.planPath === null ? null : resolvePointer(ctx, read.planPath, file.path, ws, PLAN_FOLDERS)
      const key = plan ? idOf(ctx, plan) : ledgerOnlyKey(ctx, ws, file)
      ledgerInstances.push({ key, ws, ledger: { file, read }, plan, spec: null, intent: null })
    }
  }
  for (const instance of ledgerInstances) {
    ledgerKeys.add(instance.key)
    add(instance)
  }

  // 2. Plans : un fichier sans titre de tâche n'est pas un plan. Un ledger du projet sur la même clé
  // fait apparaître le chantier là où il vit, pas dans les autres workspaces.
  const planInstances: Instance[] = []
  for (const ws of ctx.workspaces) {
    for (const file of ws.files.plans) {
      if (parsePlanTasks(file.text).length === 0) continue
      const located: Located = { file, ws }
      const key = idOf(ctx, located)
      if (ledgerKeys.has(key)) continue
      planInstances.push({ key, ws, ledger: null, plan: located, spec: null, intent: null })
    }
  }
  for (const instance of planInstances) add(instance)

  for (const instance of instances) linkSpecAndIntent(ctx, instance)

  // 3. Une spec que nul plan ne désigne ouvre un chantier.
  const designatedSpecs = new Set<string>()
  for (const instance of instances) if (instance.spec) designatedSpecs.add(idOf(ctx, instance.spec))
  // Un plan de n'importe quel workspace du projet compte, même si son chantier est montré ailleurs.
  for (const ws of ctx.workspaces) {
    for (const file of ws.files.plans) {
      const pointer = parsePlanTasks(file.text).length === 0 ? null : planSpecPointer(file.text)
      if (pointer === null) continue
      const spec = resolvePointer(ctx, pointer, file.path, ws, SPEC_FOLDERS)
      if (spec) designatedSpecs.add(idOf(ctx, spec))
    }
  }

  const specInstances: Instance[] = []
  for (const ws of ctx.workspaces) {
    for (const file of ws.files.specs) {
      const located: Located = { file, ws }
      const key = idOf(ctx, located)
      if (designatedSpecs.has(key)) continue
      specInstances.push({ key, ws, ledger: null, plan: null, spec: located, intent: null })
    }
  }
  for (const instance of specInstances) add(instance)
  for (const instance of specInstances) linkSpecAndIntent(ctx, instance)

  // 4. Un intent `-intent.md` que nulle spec ne désigne ouvre un chantier ; les autres fichiers de intents/ n'ouvrent rien.
  const designatedIntents = new Set<string>()
  for (const instance of instances) if (instance.intent) designatedIntents.add(idOf(ctx, instance.intent))
  for (const ws of ctx.workspaces) {
    for (const file of ws.files.specs) {
      const pointer = specIntentPointer(file.text)
      if (pointer === null) continue
      const intent = resolvePointer(ctx, pointer, file.path, ws, INTENT_FOLDERS)
      if (intent) designatedIntents.add(idOf(ctx, intent))
    }
  }
  for (const ws of ctx.workspaces) {
    for (const file of ws.files.intents) {
      if (!baseName(file.path).endsWith('-intent.md')) continue
      const located: Located = { file, ws }
      const key = idOf(ctx, located)
      if (designatedIntents.has(key)) continue
      add({ key, ws, ledger: null, plan: null, spec: null, intent: located })
    }
  }
  return instances
}

// ---------------------------------------------------------------------------------------------
// Tâches, étapes, fraîcheur
// ---------------------------------------------------------------------------------------------

type TaskSummary = { rows: TaskRow[]; done: number; total: number }

function compareTaskIds(a: string, b: string): number {
  const diff = parseInt(a, 10) - parseInt(b, 10)
  return diff !== 0 ? diff : a.localeCompare(b)
}

/** Tâches du plan (avec titres), sinon numéros du ledger (titre vide). */
function summarizeTasks(instance: Instance): TaskSummary {
  const ledgerTasks = instance.ledger?.read.tasks ?? {}
  const planTasks = instance.plan ? parsePlanTasks(instance.plan.file.text) : []
  const entries =
    planTasks.length > 0
      ? planTasks
      : Object.keys(ledgerTasks)
          .sort(compareTaskIds)
          .map((id) => ({ id, title: '' }))
  const rows: TaskRow[] = entries.map(({ id, title }) => {
    const state = ledgerTasks[id]
    if (state === undefined) return { id, title, status: 'todo' }
    if (state.kind === 'done') return { id, title, status: 'done' }
    if (state.kind === 'in-progress') return { id, title, status: 'in-progress' }
    return { id, title, status: 'fix', fix: { round: state.round, max: state.max } }
  })
  return { rows, done: rows.filter((row) => row.status === 'done').length, total: rows.length }
}

/** Date de dernier mouvement d'un document : fin du jour du nom de fichier (heure locale), sinon mtime. */
function documentDate(file: DocFile): number {
  const date = fileDate(baseName(file.path))
  if (date === null) return file.mtimeMs
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, 23, 59, 59, 999).getTime()
}

function labelOf(instance: Instance): string {
  const advanced = instance.plan ?? instance.spec ?? instance.intent
  if (advanced) return docLabel(baseName(advanced.file.path))
  if (instance.ledger) {
    const planPath = instance.ledger.read.planPath
    if (planPath !== null) return docLabel(baseName(planPath))
    const segments = instance.ledger.file.path.split('/')
    return segments.length >= 2 ? segments[segments.length - 2] : baseName(instance.ledger.file.path)
  }
  return instance.key
}

function toWorkstream(instance: Instance, memory: LedgerMemory, now: number): Workstream {
  const recorded = instance.ledger ? undefined : memory[instance.key]
  const notes: string[] = []
  let summary: TaskSummary
  let stage: Stage
  let unparsedLines = 0

  if (instance.ledger) {
    summary = summarizeTasks(instance)
    stage = summary.total > 0 && summary.done === summary.total ? 'review' : 'tasks'
    unparsedLines = instance.ledger.read.unparsedLines
    if (instance.plan === null) notes.push('plan not found')
  } else if (recorded) {
    // Le ledger a disparu : on ne sait plus quelles tâches étaient Done, seulement combien.
    summary = { rows: [], done: recorded.done, total: recorded.total }
    stage = 'done'
    if (recorded.done < recorded.total) notes.push(`${recorded.done} of ${recorded.total} tasks recorded`)
  } else {
    summary = summarizeTasks(instance)
    stage = instance.plan ? 'plan' : instance.spec ? 'spec' : 'intent'
  }

  const skippedStages: Stage[] = []
  const beyondSpec = stage === 'plan' || stage === 'tasks' || stage === 'review' || stage === 'done'
  if (beyondSpec && instance.spec === null) skippedStages.push('spec')
  if ((stage === 'tasks' || stage === 'review' || stage === 'done') && instance.plan === null) skippedStages.push('plan')

  const docs: Workstream['docs'] = {}
  if (instance.intent) docs.intent = instance.intent.file.path
  if (instance.spec) docs.spec = instance.spec.file.path
  if (instance.plan) docs.plan = instance.plan.file.path
  if (instance.ledger) docs.ledger = instance.ledger.file.path

  const dates = [instance.intent, instance.spec, instance.plan].flatMap((located) => (located ? [documentDate(located.file)] : []))
  if (instance.ledger) dates.push(instance.ledger.file.mtimeMs)
  const lastMovedAt = Math.max(...dates)

  const goneAt = recorded?.goneAt
  const live = now - lastMovedAt < LIVE_WINDOW_MS || (stage === 'done' && goneAt !== undefined && now - goneAt < LIVE_WINDOW_MS)

  return {
    key: instance.key,
    label: labelOf(instance),
    stage,
    hasIntent: instance.intent !== null,
    skippedStages,
    docs,
    tasks: summary.rows,
    tasksDone: summary.done,
    tasksTotal: summary.total,
    unparsedLines,
    notes,
    lastMovedAt,
    ledgerUpdatedAt: instance.ledger ? instance.ledger.file.mtimeMs : null,
    live,
  }
}

// ---------------------------------------------------------------------------------------------
// Mémoire
// ---------------------------------------------------------------------------------------------

/** Égalité hors `lastSeenAt` : le worker n'écrit le stockage que si autre chose a changé. */
export function sameMemory(a: LedgerMemory, b: LedgerMemory): boolean {
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  return keysA.every((key) => {
    const left = a[key]
    const right = b[key]
    return (
      right !== undefined &&
      left.projectKey === right.projectKey &&
      left.total === right.total &&
      left.done === right.done &&
      left.goneAt === right.goneAt
    )
  })
}

/** Mémoire d'un projet après ce tour : ledgers vus, ledgers disparus, entrées périmées retirées. */
function updateMemory(projectKey: string, instances: Instance[], memory: LedgerMemory, now: number): LedgerMemory {
  const next: LedgerMemory = { ...memory }
  const present = new Set<string>()
  for (const instance of instances) {
    if (!instance.ledger || present.has(instance.key)) continue
    present.add(instance.key)
    const { done, total } = summarizeTasks(instance)
    next[instance.key] = { projectKey, total, done, lastSeenAt: now }
  }
  for (const [key, entry] of Object.entries(memory)) {
    if (entry.projectKey !== projectKey || present.has(key)) continue
    if (entry.goneAt === undefined) next[key] = { ...entry, goneAt: now }
    else if (now - entry.goneAt > MEMORY_RETENTION_MS) delete next[key]
  }
  return next
}

// ---------------------------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------------------------

export function buildProject(input: {
  workspaces: WorkspaceInput[]
  external: Record<string, DocFile>
  memory: LedgerMemory
  now: number
}): { byWorkspace: Record<string, Workstream[]>; memory: LedgerMemory } {
  const byWorkspace: Record<string, Workstream[]> = {}
  for (const ws of input.workspaces) byWorkspace[ws.workspaceId] = []

  const projects = new Map<string, WorkspaceInput[]>()
  for (const ws of input.workspaces) {
    const group = projects.get(ws.projectKey)
    if (group) group.push(ws)
    else projects.set(ws.projectKey, [ws])
  }

  let memory = input.memory
  for (const [projectKey, workspaces] of projects) {
    const ctx = buildContext(projectKey, workspaces, input.external)
    const instances = buildInstances(ctx)
    memory = updateMemory(projectKey, instances, memory, input.now)
    for (const instance of instances) {
      byWorkspace[instance.ws.workspaceId].push(toWorkstream(instance, memory, input.now))
    }
  }

  for (const workstreams of Object.values(byWorkspace)) {
    workstreams.sort((a, b) => b.lastMovedAt - a.lastMovedAt || a.key.localeCompare(b.key))
  }
  return { byWorkspace, memory }
}
