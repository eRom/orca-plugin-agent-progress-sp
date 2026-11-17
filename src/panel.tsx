// Panneau « Agent Progress » : la fiche du projet actif d'abord, puis les autres projets et le repos.
// Il ne lit que l'instantané du worker (`progress.snapshot`, puis `progress.changed`).
import { EmptyState, Heading, Row, Spinner, Stack, Text, plugin, read, set, type PanelContext } from 'orca'
import { AtRest, OtherWork, WorkTable } from './panel/others'
import { Sheet, chosenWorkstream } from './panel/sheet'
import { applySnapshot, noticeAtom, retryDelay, snapshotAtom, snapshotRetry, workChoiceAtom } from './panel/state'
import type { ProjectView, ProjectWorkstream, Snapshot } from './protocol'

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('progress.changed', applySnapshot))
  // Tant qu'aucun instantané n'est arrivé, on relance la demande : un panneau ouvert pendant que le worker
  // attendait l'approbation restait sinon sur « Loading » pour toujours. La relance n'attend pas la fin
  // de la demande précédente (une demande perdue ne répond jamais), et s'arrête dès qu'un instantané est là.
  let timer: ReturnType<typeof setTimeout> | undefined
  const ask = (attempt: number): void => {
    if (ctx.signal.aborted || read(snapshotAtom) !== null) return
    plugin
      .request('progress.snapshot', undefined, { signal: ctx.signal })
      .then((first) => {
        // Un `progress.changed` arrivé pendant l'attente est plus récent que cette réponse.
        if (!ctx.signal.aborted && read(snapshotAtom) === null) applySnapshot(first)
      })
      .catch(() => {
        // Un panneau fermé annule la demande : ce n'est pas un échec à montrer.
        if (!ctx.signal.aborted && read(snapshotAtom) === null) set(noticeAtom, 'Could not read the work in progress.')
      })
    timer = setTimeout(() => ask(attempt + 1), retryDelay(attempt, snapshotRetry))
  }
  ask(0)
  ctx.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
}

/** Avec une fiche : le projet et la branche du worktree qui porte le chantier affiché ; sans : le workspace actif. */
function Header({ snapshot, card }: { snapshot: Snapshot | null; card?: { view: ProjectView; shown: ProjectWorkstream } }) {
  const named = card ? { name: card.view.name, branch: card.shown.branch } : (snapshot?.focused ?? null)
  return (
    <Row justify="between" align="center">
      <Heading level={3}>Superpowers</Heading>
      {named ? (
        <Text muted size="sm" truncate>
          {named.branch ? `${named.name} · ${named.branch}` : named.name}
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

  const focusedView = snapshot.live.find((view) => view.projectKey === snapshot.focusedProjectKey)
  const others = snapshot.live.filter((view) => view !== focusedView)
  const hasSheet = focusedView !== undefined
  const card = hasSheet ? { view: focusedView, shown: chosenWorkstream(focusedView, choice) } : undefined

  return (
    <Stack gap="md">
      <Header snapshot={snapshot} card={card} />
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
