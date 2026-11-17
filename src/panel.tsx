// Panneau « Agent Progress » : la fiche du workspace actif d'abord, puis les autres chantiers et le repos.
// Il ne lit que l'instantané du worker (`progress.snapshot`, puis `progress.changed`).
import { EmptyState, Heading, Row, Spinner, Stack, Text, plugin, read, set, type PanelContext } from 'orca'
import { AtRest, OtherWork, WorkTable } from './panel/others'
import { Sheet } from './panel/sheet'
import { applySnapshot, noticeAtom, snapshotAtom, workChoiceAtom } from './panel/state'
import type { Snapshot } from './protocol'

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('progress.changed', applySnapshot))
  plugin
    .request('progress.snapshot')
    .then((first) => {
      // Un `progress.changed` arrivé pendant l'attente est plus récent que cette réponse.
      if (read(snapshotAtom) === null) applySnapshot(first)
    })
    .catch(() => set(noticeAtom, 'Could not read the work in progress.'))
}

function Header({ snapshot }: { snapshot: Snapshot | null }) {
  const focused = snapshot?.focused ?? null
  return (
    <Row justify="between" align="center">
      <Heading level={3}>Superpowers</Heading>
      {focused ? (
        <Text muted size="sm" truncate>
          {focused.branch ? `${focused.name} · ${focused.branch}` : focused.name}
        </Text>
      ) : null}
    </Row>
  )
}

export default function Panel() {
  const snapshot = read(snapshotAtom)
  const notice = read(noticeAtom)
  const choice = read(workChoiceAtom)

  if (snapshot === null) {
    return (
      <Stack gap="md">
        <Header snapshot={null} />
        {notice !== null ? <Text tone="warning" size="sm">{notice}</Text> : <Spinner label="Loading" />}
      </Stack>
    )
  }

  const focusedView = snapshot.live.find((view) => view.workspaceId === snapshot.focusedWorkspaceId)
  const others = snapshot.live.filter((view) => view !== focusedView)
  const hasSheet = focusedView !== undefined

  return (
    <Stack gap="md">
      <Header snapshot={snapshot} />
      {notice !== null ? <Text tone="warning" size="sm">{notice}</Text> : null}
      {!snapshot.anySuperpowers ? (
        <EmptyState
          icon="layers"
          title="No Superpowers work in progress"
          description="Requires Superpowers. This panel follows the specs, plans and ledgers that Superpowers writes in your workspaces. Install Superpowers, start a brainstorm, and the work shows up here."
        />
      ) : null}
      {hasSheet ? <Sheet view={focusedView} localRoots={snapshot.localRoots} choice={choice} /> : null}
      {!hasSheet && others.length > 0 ? <WorkTable views={others} label="Work in progress" /> : null}
      {hasSheet && others.length > 0 ? <OtherWork views={others} /> : null}
      {snapshot.resting.length > 0 ? <AtRest resting={snapshot.resting} /> : null}
    </Stack>
  )
}
