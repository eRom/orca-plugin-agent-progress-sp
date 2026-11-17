// Les autres projets (table, repliée ou en tête) et les workspaces au repos.
import { Collapsible, List, ListItem, Table } from 'orca'
import type { ProjectView, RestingView } from '../protocol'
import { ageText, agentCell, needsYouFirst, pluralize, stageCell } from './format'
import { openWorkspace } from './state'

/** Une ligne par projet ; l'activer amène Orca sur le workspace de son chantier par défaut. */
export function WorkTable({ views, label }: { views: readonly ProjectView[]; label: string }) {
  return (
    <Table
      label={label}
      columns={[
        { key: 'project', label: 'Project', width: 'auto', minWidth: 'sm' },
        { key: 'stage', label: 'Stage', width: 'sm' },
        { key: 'agent', label: 'Agent', width: 'sm' },
      ]}
      rows={needsYouFirst(views).map((view) => ({
        key: view.projectKey,
        cells: { project: view.name, stage: stageCell(view.workstreams[0]), agent: agentCell(view) },
      }))}
      onRowAction={({ key }) => {
        const view = views.find((item) => item.projectKey === key)
        if (view !== undefined) void openWorkspace(view.workstreams[0].workspaceId)
      }}
    />
  )
}

export function OtherWork({ views }: { views: readonly ProjectView[] }) {
  const waiting = views.filter((view) => view.needsYou).length
  const description = `${views.length} in progress${waiting > 0 ? ` · ${waiting} ${waiting === 1 ? 'needs' : 'need'} you` : ''}`
  return (
    <Collapsible title="Other work in progress" description={description}>
      <WorkTable views={views} label="Other work in progress" />
    </Collapsible>
  )
}

export function AtRest({ resting }: { resting: readonly RestingView[] }) {
  const now = Date.now()
  return (
    <Collapsible title="At rest" description={`${pluralize(resting.length, 'workspace')}, nothing moved in 7 days`}>
      <List label="Workspaces at rest">
        {resting.map((item) => (
          <ListItem key={item.workspaceId} title={item.name} description={`${item.lastDoc}, ${ageText(item.lastMovedAt, now)}`} icon="folder" />
        ))}
      </List>
    </Collapsible>
  )
}
