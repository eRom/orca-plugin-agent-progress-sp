// Les typings d'Orca n'embarquent pas les types Node : on ne déclare que les membres réellement utilisés.
declare module 'node:fs/promises' {
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}
