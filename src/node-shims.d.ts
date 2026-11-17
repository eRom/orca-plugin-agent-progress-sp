// Les typings d'Orca n'embarquent pas les types Node : on ne déclare que les membres réellement utilisés.
declare module 'node:fs/promises' {
  export type Stats = { mtimeMs: number; size: number; isFile(): boolean; isDirectory(): boolean }
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function readdir(path: string): Promise<string[]>
  export function stat(path: string): Promise<Stats>
  export function writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  export function mkdtemp(prefix: string): Promise<string>
  export function utimes(path: string, atime: number, mtime: number): Promise<void>
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function dirname(path: string): string
}

declare module 'node:os' {
  export function tmpdir(): string
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}
