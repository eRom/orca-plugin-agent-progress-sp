// Texte de l'élément de barre d'état : le chantier vivant le plus récent du workspace actif.
import type { Workstream } from './model/workstream'
import type { Snapshot } from './protocol'

export type StatusBarState =
  | { visible: false }
  | { visible: true; text: string; tone: 'neutral' | 'warning'; tooltip: string }

const STAGE_TEXT = { intent: 'Intent', spec: 'Spec', review: 'Review', done: 'Done' } as const

function textOf(workstream: Workstream): string {
  switch (workstream.stage) {
    case 'plan':
      return `Plan · ${workstream.tasksTotal} ${workstream.tasksTotal === 1 ? 'task' : 'tasks'}`
    case 'tasks': {
      // Tâche courante : la première qui n'est pas Done, comptée à partir de 1.
      const index = workstream.tasks.findIndex((task) => task.status !== 'done')
      const task = index === -1 ? undefined : workstream.tasks[index]
      const current = index === -1 ? workstream.tasksTotal : index + 1
      const fix = task?.status === 'fix' && task.fix ? ` · fix ${task.fix.round}/${task.fix.max}` : ''
      return `Tasks ${current}/${workstream.tasksTotal}${fix}`
    }
    default:
      return STAGE_TEXT[workstream.stage]
  }
}

export function statusBarFor(snapshot: Snapshot): StatusBarState {
  const view = snapshot.live.find((candidate) => candidate.workspaceId === snapshot.focusedWorkspaceId)
  if (!view || view.workstreams.length === 0) return { visible: false }
  const latest = view.workstreams.reduce((best, item) => (item.lastMovedAt > best.lastMovedAt ? item : best))
  return {
    visible: true,
    text: textOf(latest),
    tone: view.needsYou ? 'warning' : 'neutral',
    tooltip: `${view.name} · ${latest.label}`,
  }
}
