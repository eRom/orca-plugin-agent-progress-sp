// La fiche d'un projet : le chantier affiché (frise, progression, tâches), ses agents, ses documents, son pied.
import { Badge, Button, IconButton, Progress, RelativeTime, Row, Select, Stack, Table, Text, read, update } from 'orca'
import type { Workstream } from '../model/workstream'
import type { ProjectAgent, ProjectView, ProjectWorkstream } from '../protocol'
import { agentName, agentVerb, isUnderAnyRoot, needsUser, pluralize, stripOf, taskStatus } from './format'
import { focusTerminal, openFile, workChoiceAtom } from './state'

const DOCUMENTS = [
  { key: 'intent', label: 'Intent' },
  { key: 'spec', label: 'Spec' },
  { key: 'plan', label: 'Plan' },
  { key: 'ledger', label: 'Ledger' },
] as const

/** Le chantier affiché : le choix gardé pour ce projet s'il existe encore, sinon le chantier par défaut. */
export function chosenWorkstream(view: ProjectView, choice: Record<string, string>): ProjectWorkstream {
  return view.workstreams.find((item) => item.key === choice[view.projectKey]) ?? view.workstreams[0]
}

function Strip({ workstream }: { workstream: Workstream }) {
  return (
    <Row gap="xs" wrap>
      {stripOf(workstream).map((step) =>
        step.state === 'current' ? (
          <Badge key={step.label} tone="accent">
            {step.label}
          </Badge>
        ) : (
          <Text key={step.label} size="xs" tone={step.state === 'done' ? 'success' : undefined} muted={step.state === 'muted'}>
            {step.state === 'done' ? `✓ ${step.label}` : step.label}
          </Text>
        ),
      )}
    </Row>
  )
}

/** Un agent dont le terminal n'est pas dans le workspace du chantier affiché dit où il se trouve. */
function Agents({ agents, workspaceId }: { agents: readonly ProjectAgent[]; workspaceId: string }) {
  return (
    <Stack gap="xs">
      {agents.map((agent, index) => (
        <Row key={agent.terminalId ?? `agent-${index}`} justify="between" align="center">
          <Text size="sm" tone={needsUser(agent) ? 'warning' : undefined}>
            {`${agentName(agent.agent)} ${agentVerb(agent.state)} `}
            <RelativeTime at={agent.since} format="duration" tone={needsUser(agent) ? 'warning' : undefined} />
            {agent.workspaceId !== workspaceId ? ` · in ${agent.location}` : null}
          </Text>
          {agent.terminalId !== null ? (
            <IconButton
              icon="terminal"
              label="Go to terminal"
              size="sm"
              variant="ghost"
              onPress={() => void focusTerminal(agent.terminalId as string)}
            />
          ) : null}
        </Row>
      ))}
    </Stack>
  )
}

function Footer({ workstream }: { workstream: Workstream }) {
  const unparsed = workstream.unparsedLines > 0 ? ` · ${pluralize(workstream.unparsedLines, 'line')} not understood` : ''
  const notes = workstream.notes.map((note) => ` · ${note}`).join('')
  return (
    <Text muted size="xs">
      {workstream.label}
      {workstream.ledgerUpdatedAt !== null ? ' · ledger updated ' : null}
      {workstream.ledgerUpdatedAt !== null ? <RelativeTime at={workstream.ledgerUpdatedAt} format="short" muted /> : null}
      {`${unparsed}${notes}`}
    </Text>
  )
}

export function Sheet({ view, localRoots, choice }: { view: ProjectView; localRoots: readonly string[]; choice: Record<string, string> }) {
  const workstream = chosenWorkstream(view, choice)
  const documents = DOCUMENTS.flatMap((doc) => {
    const path = workstream.docs[doc.key]
    return path !== undefined && isUnderAnyRoot(path, localRoots) ? [{ ...doc, path }] : []
  })
  return (
    <Stack gap="sm">
      {view.workstreams.length > 1 ? (
        <Select
          label="Work"
          value={workstream.key}
          options={view.workstreams.map((item) => ({ value: item.key, label: item.label }))}
          onChange={(value) => update(workChoiceAtom, (previous) => ({ ...previous, [view.projectKey]: value }))}
        />
      ) : null}
      <Strip workstream={workstream} />
      {workstream.tasksTotal > 0 ? (
        <Progress
          label={`Tasks ${workstream.tasksDone} of ${workstream.tasksTotal}`}
          value={Math.round((workstream.tasksDone / workstream.tasksTotal) * 100)}
        />
      ) : null}
      {workstream.tasks.length > 0 ? (
        <Table
          label={`Tasks of ${workstream.label}`}
          maxHeight="md"
          columns={[
            { key: 'id', label: '#', width: 'xs' },
            { key: 'title', label: 'Task', width: 'auto' },
            { key: 'status', label: 'Status', width: 'sm' },
          ]}
          rows={workstream.tasks.map((task) => ({ key: task.id, cells: { id: task.id, title: task.title, status: taskStatus(task) } }))}
        />
      ) : null}
      {view.agents.length > 0 ? <Agents agents={view.agents} workspaceId={workstream.workspaceId} /> : null}
      {documents.length > 0 ? (
        <Row gap="xs" wrap>
          {documents.map((doc) => (
            <Button key={doc.key} size="xs" variant="outline" icon="file-text" onPress={() => void openFile(workstream.workspaceId, doc.path)}>
              {doc.label}
            </Button>
          ))}
        </Row>
      ) : null}
      <Footer workstream={workstream} />
    </Stack>
  )
}
