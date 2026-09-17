import { describe, expect, it } from 'vitest'
import { mergeLinuxUpdateMetadata } from '../scripts/merge-linux-update-metadata.mjs'

const x64 = {
  version: '1.2.3',
  files: [{ url: 'dsh-desktop-linux-x64.tar.gz', size: 10, sha512: 'sha-x64' }],
  path: 'dsh-desktop-linux-x64.tar.gz',
  sha512: 'sha-x64',
  releaseDate: '2026-01-01T00:00:00.000Z'
}
const arm64 = {
  version: '1.2.3',
  files: [{ url: 'dsh-desktop-linux-arm64.tar.gz', size: 11, sha512: 'sha-arm64' }],
  path: 'dsh-desktop-linux-arm64.tar.gz',
  sha512: 'sha-arm64',
  releaseDate: '2026-01-01T00:01:00.000Z'
}

describe('linux update metadata merge', () => {
  it('merges both tar.gz entries with the x64 entry primary', () => {
    const merged = mergeLinuxUpdateMetadata(x64, arm64)
    expect(merged.version).toBe('1.2.3')
    expect(merged.files.map((file) => file.url)).toEqual([
      'dsh-desktop-linux-arm64.tar.gz',
      'dsh-desktop-linux-x64.tar.gz'
    ])
    expect(merged.path).toBe('dsh-desktop-linux-x64.tar.gz')
    expect(merged.sha512).toBe('sha-x64')
    expect(merged.releaseDate).toBe('2026-01-01T00:01:00.000Z')
  })

  it('rejects metadata whose versions differ', () => {
    expect(() =>
      mergeLinuxUpdateMetadata(x64, { ...arm64, version: '1.2.4' })
    ).toThrow('Linux update versions differ')
  })

  it('rejects metadata missing its arch tar.gz entry', () => {
    expect(() =>
      mergeLinuxUpdateMetadata(x64, {
        ...arm64,
        files: [{ url: 'dsh-desktop-linux-arm64.deb', size: 1, sha512: 'sha' }]
      })
    ).toThrow('arm64 update metadata has no matching tar.gz')
  })
})
