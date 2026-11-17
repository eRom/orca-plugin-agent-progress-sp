// Lecteur de ledger Superpowers : pur, sans import Node ni Orca.
// Les lignes d'un ledger sont de la prose écrite par un modèle : on ne retient que les formes sûres,
// on compte celles qu'on ne comprend pas, on n'interprète jamais le reste.

export type TaskState = { kind: 'done' } | { kind: 'in-progress' } | { kind: 'fix'; round: number; max: number }

export type LedgerRead = {
  /** Chemin tel qu'écrit après `plan:` sur la 1re ligne, ou null. */
  planPath: string | null
  /** Clé : numéro de tâche en minuscules ('4', '3a'). */
  tasks: Record<string, TaskState>
  /** Lignes de tâche dont le premier mot n'est pas une forme connue. */
  unparsedLines: number
}

// `# SDD ledger — plan: <chemin>` ou `# SDD ledger - plan: <chemin>`.
const HEADER = /^#\s*SDD ledger\s*[—–-]\s*plan:\s*(\S.*?)\s*$/
// Puce optionnelle, `Task` ou `Tasks`, liste de numéros, deux-points avec ou sans espace avant.
const TASK_LINE = /^\s*(?:-\s+)?Tasks?\s+(\d+[a-z]?(?:\s*[+,-]\s*\d+[a-z]?)*)\s*:\s*(.*)$/i
const FIRST_WORD = /^([\p{L}][\p{L}\p{N}_-]*)/u
const FIX_ROUND = /^fix\s+round\s+(\d+)\s*\/\s*(\d+)(?!\d)/i

// Une plage plus longue que ça n'est pas une plage de tâches : on la refuse au lieu de l'étendre.
const MAX_RANGE_SPAN = 100

// Mots connus sans effet sur l'état : journal, hors v1.
const NO_EFFECT_WORDS = new Set(['minor', 'parked', 'ruling', 'released', 'note', 'base'])
const IN_PROGRESS_WORDS = new Set(['dispatched', 'review', 'implemented', 'implementer', 're-review'])

/** Développe `3+4`, `2-4`, `1, 3a` en numéros minuscules ; null si la liste n'est pas lisible. */
function expandNumbers(list: string): string[] | null {
  const numbers: string[] = []
  for (const part of list.split(/[+,]/)) {
    const trimmed = part.trim()
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (end < start || end - start >= MAX_RANGE_SPAN) return null
      for (let n = start; n <= end; n += 1) numbers.push(String(n))
    } else if (/^\d+[a-z]?$/i.test(trimmed)) {
      numbers.push(trimmed.toLowerCase())
    } else {
      return null
    }
  }
  return numbers
}

/** Effet d'une ligne de tâche : un état, « aucun effet », ou « non comprise » (null). */
function readEffect(rest: string): TaskState | 'none' | null {
  const word = FIRST_WORD.exec(rest)?.[1].toLowerCase()
  if (word === undefined) return null
  if (word === 'complete') return { kind: 'done' }
  if (word === 'fix') {
    const round = FIX_ROUND.exec(rest)
    return round ? { kind: 'fix', round: Number(round[1]), max: Number(round[2]) } : null
  }
  if (IN_PROGRESS_WORDS.has(word)) return { kind: 'in-progress' }
  if (NO_EFFECT_WORDS.has(word)) return 'none'
  return null
}

export function parseLedger(text: string): LedgerRead {
  const lines = text.split(/\r?\n/)
  const planPath = HEADER.exec(lines[0] ?? '')?.[1] ?? null
  const tasks: Record<string, TaskState> = {}
  let unparsedLines = 0

  for (const line of lines) {
    const match = TASK_LINE.exec(line)
    if (!match) continue
    const numbers = expandNumbers(match[1])
    const effect = numbers === null ? null : readEffect(match[2])
    if (numbers === null || effect === null) {
      unparsedLines += 1
      continue
    }
    if (effect === 'none') continue
    for (const number of numbers) {
      // Done est définitif : aucune ligne ultérieure ne le défait.
      if (tasks[number]?.kind === 'done') continue
      tasks[number] = effect
    }
  }

  return { planPath, tasks, unparsedLines }
}
