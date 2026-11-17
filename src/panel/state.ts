// État du panneau (atomes) et actions vers le worker. Le panneau ne lit que l'instantané.
import { atom, plugin, set } from 'orca'
import type { Snapshot } from '../protocol'

/** Le dernier instantané reçu ; null tant que le worker n'a pas répondu. */
export const snapshotAtom = atom<Snapshot | null>(null)
/** Chantier choisi dans le sélecteur `Work`, par workspace. */
export const workChoiceAtom = atom<Record<string, string>>({})
/** Dernier échec d'une action ou de la lecture de l'instantané, à montrer à la personne. */
export const noticeAtom = atom<string | null>(null)

/** Lance une action du worker ; un refus ou un échec laisse un message au lieu de passer sous silence. */
async function act(call: () => Promise<boolean>, failure: string): Promise<void> {
  set(noticeAtom, null)
  try {
    if (!(await call())) set(noticeAtom, failure)
  } catch {
    set(noticeAtom, failure)
  }
}

export const openFile = (workspaceId: string, path: string): Promise<void> =>
  act(async () => (await plugin.request('progress.openFile', { workspaceId, path })).opened, 'Could not open this document.')

export const focusTerminal = (terminalId: string): Promise<void> =>
  act(async () => (await plugin.request('progress.focusTerminal', { terminalId })).focused, 'Could not reach this terminal.')

export const openWorkspace = (workspaceId: string): Promise<void> =>
  act(async () => (await plugin.request('progress.openWorkspace', { workspaceId })).opened, 'Could not open this workspace.')
