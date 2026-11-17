// Lecteur de documents Superpowers : pur, sans import Node ni Orca.
// Plans, specs et intentions sont de la prose : on ne lit que les formes d'en-tête connues,
// dans les premières lignes, et on rend null quand rien n'est reconnu.

export type PlanTask = { id: string; title: string }

// Titre de tâche d'un plan : `### Task 3: titre`, `## Task 3a - titre`, `#### task 4. titre`.
const TASK_HEADING = /^#{2,4}\s*Task\s+(\d+[a-z]?)\s*[:.\-–]?\s*(.*)$/i

// Fenêtres de lecture des pointeurs : l'en-tête d'un document, jamais son corps.
const PLAN_POINTER_LINES = 40
const SPEC_POINTER_LINES = 5

// Chemin `docs/superpowers/<dossier>/<fichier>.md`, avec ou sans backticks, dans un lien Markdown ou non.
const DOC_PATH = /docs\/superpowers\/[^/\s`()[\]]+\/[^/\s`()[\]]+\.md/
const INTENT_PATH = /docs\/superpowers\/intents\/[^/\s`()[\]]+\.md/
// Nom nu `YYYY-MM-DD-<sujet>-intent.md`, sans dossier.
const BARE_INTENT_NAME = /\d{4}-\d{2}-\d{2}-[^\s`/()[\]]*-intent\.md/

const FILE_DATE = /^(\d{4}-\d{2}-\d{2})(?!\d)/
const REPO_MARKERS = ['/docs/superpowers/', '/.superpowers/']

function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

/** Tâches d'un plan, dans l'ordre du fichier ; ids en minuscules, doublons ignorés (le premier gagne). */
export function parsePlanTasks(text: string): PlanTask[] {
  const tasks: PlanTask[] = []
  const seen = new Set<string>()
  for (const line of splitLines(text)) {
    const match = TASK_HEADING.exec(line)
    if (!match) continue
    const id = match[1].toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    tasks.push({ id, title: match[2].trim() })
  }
  return tasks
}

/** Chemin de la spec citée par un plan : 1er chemin de la 1re ligne `**Spec:**` ou `**Spec :**` des 40 premières lignes. */
export function planSpecPointer(text: string): string | null {
  for (const line of splitLines(text).slice(0, PLAN_POINTER_LINES)) {
    if (!/^\s*\*\*Spec\s?:\*\*/.test(line)) continue
    return DOC_PATH.exec(line)?.[0] ?? null
  }
  return null
}

/** Chemin de l'intention citée par une spec, dans ses 5 premières lignes ; un nom nu est rendu sous `docs/superpowers/intents/`. */
export function specIntentPointer(text: string): string | null {
  const head = splitLines(text).slice(0, SPEC_POINTER_LINES).join('\n')
  const fullPath = INTENT_PATH.exec(head)
  if (fullPath) return fullPath[0]
  const bareName = BARE_INTENT_NAME.exec(head)
  return bareName ? `docs/superpowers/intents/${bareName[0]}` : null
}

/** Date `YYYY-MM-DD` en tête d'un nom de fichier, sinon null. */
export function fileDate(fileName: string): string | null {
  return FILE_DATE.exec(fileName)?.[1] ?? null
}

/** Nom lisible d'un document : sans date, sans `-design`, sans `.md` ; le nom nu si rien ne reste. */
export function docLabel(fileName: string): string {
  const withoutExtension = fileName.replace(/\.md$/i, '')
  const label = withoutExtension.replace(/^\d{4}-\d{2}-\d{2}-?/, '').replace(/-design$/, '')
  return label || withoutExtension
}

/** Racine du dépôt : préfixe avant `/docs/superpowers/` ou `/.superpowers/` (le plus à gauche), sinon null. */
export function repoRootOf(absPath: string): string | null {
  let cut = -1
  for (const marker of REPO_MARKERS) {
    const index = absPath.indexOf(marker)
    if (index > 0 && (cut === -1 || index < cut)) cut = index
  }
  return cut === -1 ? null : absPath.slice(0, cut)
}
