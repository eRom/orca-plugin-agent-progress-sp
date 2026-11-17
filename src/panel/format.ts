// Mise en forme pure du panneau : textes, frise, choix des documents ouvrables. Aucun composant, aucun état.
import type { Stage, TaskRow, Workstream } from '../model/workstream'
import type { AgentRow, ProjectView } from '../protocol'

const STAGES: readonly { stage: Stage; label: string }[] = [
  { stage: 'intent', label: 'Intent' },
  { stage: 'spec', label: 'Spec' },
  { stage: 'plan', label: 'Plan' },
  { stage: 'tasks', label: 'Tasks' },
  { stage: 'review', label: 'Review' },
  { stage: 'done', label: 'Done' },
]

export const stageLabel = (stage: Stage): string => STAGES.find((entry) => entry.stage === stage)?.label ?? stage

export type StripStep = { label: string; state: 'current' | 'done' | 'muted' }

/** La frise d'un chantier : l'étape courante, les passées cochées, les sautées et les à venir atténuées. */
export function stripOf(workstream: Workstream): StripStep[] {
  const currentIndex = STAGES.findIndex((entry) => entry.stage === workstream.stage)
  const steps: StripStep[] = []
  STAGES.forEach((entry, index) => {
    if (entry.stage === 'intent' && !workstream.hasIntent) return
    let state: StripStep['state'] = 'muted'
    if (index === currentIndex) state = 'current'
    else if (index < currentIndex && !workstream.skippedStages.includes(entry.stage)) state = 'done'
    steps.push({ label: entry.label, state })
  })
  return steps
}

export function taskStatus(task: TaskRow): string {
  switch (task.status) {
    case 'done':
      return 'Done'
    case 'fix':
      return task.fix ? `Fix ${task.fix.round}/${task.fix.max}` : 'Fix'
    case 'in-progress':
      return 'In progress'
    default:
      return '·'
  }
}

/** Colonne Stage du tableau des autres chantiers : `Task k/N` à l'étape Tasks, sinon le nom de l'étape. */
export function stageCell(workstream: Workstream): string {
  if (workstream.stage !== 'tasks' || workstream.tasksTotal === 0) return stageLabel(workstream.stage)
  // Tâche courante : la première qui n'est pas Done, comptée à partir de 1 (comme la barre d'état).
  const index = workstream.tasks.findIndex((task) => task.status !== 'done')
  return `Task ${index === -1 ? workstream.tasksTotal : index + 1}/${workstream.tasksTotal}`
}

export function agentCell(view: ProjectView): string {
  if (view.needsYou) return '● Needs you'
  return view.agents.some((agent) => agent.state === 'working') ? 'Working' : ''
}

/** `claude` -> `Claude`, `null` -> `Agent`. */
export function agentName(agent: string | null): string {
  if (agent === null || agent === '') return 'Agent'
  return agent.charAt(0).toUpperCase() + agent.slice(1)
}

export function agentVerb(state: AgentRow['state']): string {
  if (state === 'working') return 'working for'
  return state === 'done' ? 'idle for' : 'needs you for'
}

export const needsUser = (agent: AgentRow): boolean => agent.state === 'blocked' || agent.state === 'waiting'

/** Ceux qui attendent l'utilisateur d'abord, l'ordre d'origine ensuite (tri stable). */
export const needsYouFirst = (views: readonly ProjectView[]): ProjectView[] =>
  [...views].sort((a, b) => Number(b.needsYou) - Number(a.needsYou))

const stripTrailingSlash = (root: string): string => (root.length > 1 ? root.replace(/\/+$/, '') : root)

/** Un document ne devient un bouton que sous la racine d'un workspace local (préfixe `${root}/`). */
export function isUnderAnyRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path.startsWith(`${stripTrailingSlash(root)}/`))
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/** Un âge en texte fixe, calculé à l'affichage : `RelativeTime` n'entre pas dans une description. */
export function ageText(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${pluralize(Math.floor(hours / 24), 'day')} ago`
}
