// Audit des vrais ledgers : compare le parseur à un décompte indépendant.
// Usage : bun scripts/audit-ledgers.ts <racine>...
// Écrit une ligne `<chemin> done=<n> completeIds=<m> unparsed=<u> <ok|MISMATCH>` par ledger ; code 1 au moindre MISMATCH.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseLedger } from '../src/model/ledger.ts'

const SKIPPED_DIRS = new Set(['node_modules', '.git'])

type Found = { ledgers: string[]; hasSuperpowers: boolean }

/** Parcourt une racine : tous les `.superpowers/sdd/**\/progress.md`, sans node_modules ni liens symboliques. */
function walk(dir: string, found: Found, insideSdd: boolean): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      if (entry.name === '.superpowers') found.hasSuperpowers = true
      const enteringSdd = !insideSdd && dir.endsWith('/.superpowers') && entry.name === 'sdd'
      walk(path, found, insideSdd || enteringSdd)
    } else if (entry.isFile() && insideSdd && entry.name === 'progress.md') {
      found.ledgers.push(path)
    }
  }
}

/** Fichiers `.md` de premier niveau d'un dossier de corpus. */
function topLevelMarkdown(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(dir, entry.name))
    .sort()
}

/**
 * Décompte indépendant du parseur : numéros distincts des lignes de tâche dont le premier mot est `complete`.
 * Regex et dépliage volontairement réécrits ici, pour ne pas partager un défaut avec src/model/ledger.ts.
 */
function countCompleteIds(text: string): number {
  const ids = new Set<string>()
  for (const line of text.split('\n')) {
    const match = /^\s*(?:-\s+)?tasks?\s+(\d+[a-z]?(?:\s*[+,-]\s*\d+[a-z]?)*)\s*:\s*complete(?![a-z0-9_-])/i.exec(line)
    if (!match) continue
    for (const part of match[1].split(/[+,]/)) {
      const piece = part.trim().toLowerCase()
      const range = /^(\d+)\s*-\s*(\d+)$/.exec(piece)
      if (range) {
        for (let n = Number(range[1]); n <= Number(range[2]); n += 1) ids.add(String(n))
      } else if (piece !== '') {
        ids.add(piece)
      }
    }
  }
  return ids.size
}

const roots = process.argv.slice(2)
if (roots.length === 0) {
  console.error('usage: bun scripts/audit-ledgers.ts <root>...')
  process.exit(2)
}

let audited = 0
let mismatches = 0
for (const root of roots) {
  const found: Found = { ledgers: [], hasSuperpowers: false }
  walk(root, found, false)
  const files = found.hasSuperpowers ? found.ledgers : topLevelMarkdown(root)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const read = parseLedger(text)
    const done = Object.values(read.tasks).filter((state) => state.kind === 'done').length
    const completeIds = countCompleteIds(text)
    const verdict = done === completeIds ? 'ok' : 'MISMATCH'
    if (verdict === 'MISMATCH') mismatches += 1
    audited += 1
    console.log(`${file} done=${done} completeIds=${completeIds} unparsed=${read.unparsedLines} ${verdict}`)
  }
}
console.log(`audited=${audited} mismatches=${mismatches}`)
process.exit(mismatches > 0 ? 1 : 0)
