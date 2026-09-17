import { readFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'

// Linux generic-feed metadata: electron-builder emits one latest-linux.yml per
// arch (each listing that arch's tar.gz). The update feed serves a single
// latest-linux.yml, so both arches' entries are merged here — mirroring
// merge-mac-update-metadata.mjs. Deb/RPM packages never flow through
// electron-updater; only the tar.gz entries (auto-update fallback channel).
export function mergeLinuxUpdateMetadata(x64, arm64) {
  assertMetadata(x64, 'x64')
  assertMetadata(arm64, 'arm64')
  if (x64.version !== arm64.version) {
    throw new Error(`Linux update versions differ: ${x64.version} and ${arm64.version}`)
  }

  const files = deduplicateFiles([...x64.files, ...arm64.files]).filter((file) =>
    file.url.endsWith('.tar.gz')
  )
  const primary = files.find((file) => file.url.includes('x64') && file.url.endsWith('.tar.gz'))
  if (!primary) throw new Error('Merged Linux update metadata has no x64 tar.gz')

  return {
    version: x64.version,
    files,
    path: primary.url,
    sha512: primary.sha512,
    releaseDate: latestReleaseDate(x64.releaseDate, arm64.releaseDate)
  }
}

function assertMetadata(metadata, architecture) {
  if (!metadata || typeof metadata !== 'object') {
    throw new Error(`${architecture} update metadata is invalid`)
  }
  if (typeof metadata.version !== 'string' || !Array.isArray(metadata.files)) {
    throw new Error(`${architecture} update metadata is missing version or files`)
  }
  const architectureFiles = metadata.files.filter((file) => file?.url?.includes(architecture))
  if (!architectureFiles.some((file) => file.url.endsWith('.tar.gz'))) {
    throw new Error(`${architecture} update metadata has no matching tar.gz`)
  }
  for (const file of architectureFiles) {
    if (typeof file.sha512 !== 'string' || !file.sha512) {
      throw new Error(`${architecture} update file ${file.url} has no sha512`)
    }
  }
}

function deduplicateFiles(files) {
  const unique = new Map()
  for (const file of files) {
    if (!file?.url) continue
    unique.set(file.url, file)
  }
  return [...unique.values()].sort((left, right) => left.url.localeCompare(right.url))
}

function latestReleaseDate(left, right) {
  const dates = [left, right].filter((value) => typeof value === 'string').sort()
  return dates.at(-1)
}

async function main() {
  const [x64Path, arm64Path, outputPath] = process.argv.slice(2)
  if (!x64Path || !arm64Path || !outputPath) {
    throw new Error(
      'Usage: node scripts/merge-linux-update-metadata.mjs <x64.yml> <arm64.yml> <output.yml>'
    )
  }
  const [x64, arm64] = await Promise.all([
    readFile(x64Path, 'utf8').then(parse),
    readFile(arm64Path, 'utf8').then(parse)
  ])
  const merged = mergeLinuxUpdateMetadata(x64, arm64)
  await writeFile(outputPath, stringify(merged), 'utf8')
  console.log(`Merged Linux update metadata for version ${merged.version}.`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
