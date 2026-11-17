// Lecteur du disque : lit les fichiers Superpowers d'un workspace avec un cache par date et taille.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DocFile, WorkspaceFiles } from './model/workstream'

export type ScanFs = {
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<{ mtimeMs: number; size: number; isFile(): boolean; isDirectory(): boolean }>
  readFile(path: string, encoding: 'utf8'): Promise<string>
}

export const nodeScanFs: ScanFs = {
  readdir: (path) => readdir(path),
  stat: (path) => stat(path),
  readFile: (path, encoding) => readFile(path, encoding),
}

type CacheEntry = { mtimeMs: number; size: number; text: string }

/** Taille maximale lue : 1 Mio. */
const MAX_FILE_BYTES = 1_048_576

const DOC_KINDS =['intents', 'specs', 'plans'] as const

/** ENOENT, ou ENOTDIR quand un parent du chemin est un fichier : dans les deux cas, rien à lire. */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && ['ENOENT', 'ENOTDIR'].includes((error as { code?: string }).code ?? '')
}

export function createScanner(fs: ScanFs = nodeScanFs): {
  scanWorkspace(root: string): Promise<WorkspaceFiles>
  readExternal(paths: readonly string[]): Promise<Record<string, DocFile>>
} {
  const cache = new Map<string, CacheEntry>()

  /** Un dossier absent vaut une liste vide ; toute autre erreur remonte. */
  async function listDir(dir: string): Promise<string[]> {
    try {
      return (await fs.readdir(dir)).sort()
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
  }

  /** Lit un fichier via le cache ; null si le chemin n'existe pas (ou disparaît entre deux appels) ou n'est pas un fichier. */
  async function readDoc(path: string): Promise<DocFile | null> {
    let info
    try {
      info = await fs.stat(path)
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
    // Un fichier trop gros n'est pas un document Superpowers (le plus gros observé : 98,6 Ko) : absent, jamais lu.
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null
    const cached = cache.get(path)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return { path, text: cached.text, mtimeMs: info.mtimeMs }
    }
    let text: string
    try {
      text = await fs.readFile(path, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
    cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, text })
    return { path, text, mtimeMs: info.mtimeMs }
  }

  async function readAll(paths: string[]): Promise<DocFile[]> {
    const docs = await Promise.all(paths.map(readDoc))
    return docs.filter((doc): doc is DocFile => doc !== null)
  }

  async function scanDocs(root: string, kind: (typeof DOC_KINDS)[number]): Promise<DocFile[]> {
    const dir = join(root, 'docs', 'superpowers', kind)
    const names = await listDir(dir)
    return readAll(names.filter((name) => name.endsWith('.md')).map((name) => join(dir, name)))
  }

  async function scanLedgers(root: string): Promise<DocFile[]> {
    const sddDir = join(root, '.superpowers', 'sdd')
    const names = await listDir(sddDir)
    // Ancien emplacement, puis un progress.md par sous-dossier ; les sous-dossiers sans ledger sont ignorés.
    const candidates = [join(sddDir, 'progress.md')]
    for (const name of names) {
      if (name === 'progress.md') continue
      candidates.push(join(sddDir, name, 'progress.md'))
    }
    return readAll(candidates)
  }

  return {
    async scanWorkspace(root) {
      const [intents, specs, plans, ledgers] = await Promise.all([
        scanDocs(root, 'intents'),
        scanDocs(root, 'specs'),
        scanDocs(root, 'plans'),
        scanLedgers(root),
      ])
      return { intents, specs, plans, ledgers }
    },

    async readExternal(paths) {
      const result: Record<string, DocFile> = {}
      for (const path of paths) {
        // Un fichier désigné par un document ne doit jamais bloquer le projet : toute erreur de lecture vaut « absent ».
        try {
          const doc = await readDoc(path)
          if (doc) result[path] = doc
        } catch {
          continue
        }
      }
      return result
    },
  }
}
