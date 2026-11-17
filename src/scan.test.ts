// Joue le scanner sur un dossier temporaire peuplé à la main, avec un ScanFs qui compte les lectures.
import { mkdir, mkdtemp, rm, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { createScanner, nodeScanFs, type ScanFs } from './scan'

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-progress-sp-scan-'))
  try {
    await run(root)
  } finally {
    // Nettoyage du dossier créé par le test lui-même.
    await rm(root, { recursive: true, force: true })
  }
}

async function put(root: string, relativePath: string, text = '# doc\n'): Promise<string> {
  const path = join(root, relativePath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
  return path
}

/** Enveloppe nodeScanFs et compte les lectures de fichiers. */
function countingFs(): { fs: ScanFs; reads: string[] } {
  const reads: string[] = []
  const fs: ScanFs = {
    readdir: (path) => nodeScanFs.readdir(path),
    stat: (path) => nodeScanFs.stat(path),
    readFile: (path, encoding) => {
      reads.push(path)
      return nodeScanFs.readFile(path, encoding)
    },
  }
  return { fs, reads }
}

const paths = (files: { path: string }[]): string[] => files.map((file) => file.path).sort()

test('scans intents, specs, plans and both ledger locations, and nothing else', async () => {
  await withTempRoot(async (root) => {
    const intent = await put(root, 'docs/superpowers/intents/2026-01-01-demo.md', '# intent\n')
    const spec = await put(root, 'docs/superpowers/specs/2026-01-01-demo-design.md', '# spec\n')
    const planA = await put(root, 'docs/superpowers/plans/2026-01-01-a.md')
    const planB = await put(root, 'docs/superpowers/plans/2026-01-02-b.md')
    await put(root, 'docs/superpowers/plans/archive/2025-12-31-old.md')
    await put(root, 'docs/superpowers/plans/notes.txt')
    const sddLedger = await put(root, '.superpowers/sdd/2026-01-01-a/progress.md', '## ledger\n')
    const legacyLedger = await put(root, '.superpowers/sdd/progress.md', '## legacy\n')
    await put(root, '.superpowers/sdd/2026-01-01-a/progress.md.tmp.123')
    await put(root, '.superpowers/sdd/2026-01-01-a/task-1-brief.md')
    await put(root, '.superpowers/sdd/stray-note.md')

    const files = await createScanner().scanWorkspace(root)

    assert.deepEqual(paths(files.intents), [intent])
    assert.deepEqual(paths(files.specs), [spec])
    assert.deepEqual(paths(files.plans), [planA, planB])
    assert.deepEqual(paths(files.ledgers), [legacyLedger, sddLedger].sort())
    assert.equal(files.intents[0].text, '# intent\n')
    assert.ok(files.ledgers.every((file) => file.mtimeMs > 0))
  })
})

test('returns four empty lists for a workspace without Superpowers directories', async () => {
  await withTempRoot(async (root) => {
    const files = await createScanner().scanWorkspace(root)
    assert.deepEqual(files, { intents: [], specs: [], plans: [], ledgers: [] })
  })
})

test('does not re-read unchanged files and re-reads only the one whose date changed', async () => {
  await withTempRoot(async (root) => {
    await put(root, 'docs/superpowers/specs/a.md', 'one')
    await put(root, 'docs/superpowers/plans/b.md', 'two')
    const ledger = await put(root, '.superpowers/sdd/p/progress.md', 'three')
    const { fs, reads } = countingFs()
    const scanner = createScanner(fs)

    await scanner.scanWorkspace(root)
    assert.equal(reads.length, 3)

    reads.length = 0
    await scanner.scanWorkspace(root)
    assert.equal(reads.length, 0)

    // Même taille, date différente : le fichier doit être relu.
    await writeFile(ledger, 'THREE', 'utf8')
    await utimes(ledger, 1_700_000_000, 1_700_000_000)
    reads.length = 0
    const files = await scanner.scanWorkspace(root)
    assert.deepEqual(reads, [ledger])
    assert.equal(files.ledgers[0].text, 'THREE')
  })
})

test('readExternal returns only existing files and shares the cache', async () => {
  await withTempRoot(async (root) => {
    const present = await put(root, 'elsewhere/plan.md', 'external')
    const absent = join(root, 'elsewhere/missing.md')
    const { fs, reads } = countingFs()
    const scanner = createScanner(fs)

    const result = await scanner.readExternal([present, absent])
    assert.deepEqual(Object.keys(result), [present])
    assert.equal(result[present].text, 'external')

    reads.length = 0
    await scanner.readExternal([present])
    assert.equal(reads.length, 0)
  })
})

test('rejects when a directory cannot be read instead of returning empty lists', async () => {
  const denied: ScanFs = {
    readdir: async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    },
    stat: nodeScanFs.stat,
    readFile: nodeScanFs.readFile,
  }
  let failure: unknown = null
  try {
    await createScanner(denied).scanWorkspace('/anywhere')
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof Error)
  assert.ok((failure as Error).message.includes('EACCES'))
})

const MIB = 1_048_576

test('readExternal omits a file whose stat or read throws instead of rejecting', async () => {
  await withTempRoot(async (root) => {
    const good = await put(root, 'elsewhere/good.md', 'fine')
    const statDenied = join(root, 'elsewhere/stat-denied.md')
    const readDenied = await put(root, 'elsewhere/read-denied.md', 'secret')
    const fs: ScanFs = {
      readdir: nodeScanFs.readdir,
      stat: async (path) => {
        if (path === statDenied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        return nodeScanFs.stat(path)
      },
      readFile: async (path, encoding) => {
        if (path === readDenied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        return nodeScanFs.readFile(path, encoding)
      },
    }
    const result = await createScanner(fs).readExternal([statDenied, readDenied, good])
    assert.deepEqual(Object.keys(result), [good])
  })
})

test('scanWorkspace rejects when an existing ledger cannot be stat-ed or read', async () => {
  await withTempRoot(async (root) => {
    const ledger = await put(root, '.superpowers/sdd/p/progress.md', 'ledger')
    const denied = (failing: 'stat' | 'readFile'): ScanFs => ({
      readdir: nodeScanFs.readdir,
      stat: async (path) => {
        if (failing === 'stat' && path === ledger) throw Object.assign(new Error('EACCES: stat denied'), { code: 'EACCES' })
        return nodeScanFs.stat(path)
      },
      readFile: async (path, encoding) => {
        if (failing === 'readFile' && path === ledger) throw Object.assign(new Error('EACCES: read denied'), { code: 'EACCES' })
        return nodeScanFs.readFile(path, encoding)
      },
    })
    for (const failing of ['stat', 'readFile'] as const) {
      let failure: unknown = null
      try {
        await createScanner(denied(failing)).scanWorkspace(root)
      } catch (error) {
        failure = error
      }
      assert.ok(failure instanceof Error, `${failing} failure must reject`)
      assert.ok((failure as Error).message.includes('EACCES'))
    }
  })
})

test('a file larger than 1 MiB is absent and never read; exactly 1 MiB is read', async () => {
  await withTempRoot(async (root) => {
    const big = await put(root, 'docs/superpowers/plans/big.md', '')
    await truncate(big, MIB + 1)
    const edge = await put(root, 'docs/superpowers/plans/edge.md', '')
    await truncate(edge, MIB)
    const bigExternal = await put(root, 'elsewhere/big.md', '')
    await truncate(bigExternal, MIB + 1)
    const { fs, reads } = countingFs()
    const scanner = createScanner(fs)

    const files = await scanner.scanWorkspace(root)
    assert.deepEqual(paths(files.plans), [edge])
    const external = await scanner.readExternal([bigExternal])
    assert.deepEqual(external, {})
    assert.ok(!reads.includes(big) && !reads.includes(bigExternal), 'oversized files must not be read')
  })
})
