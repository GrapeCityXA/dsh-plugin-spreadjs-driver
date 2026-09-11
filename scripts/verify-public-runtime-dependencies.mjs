// Enforce that every runtime dependency is a public registry specifier, so the
// published tarball never leaks a file:/link:/workspace:/git: reference.
import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

const deniedPrefixes = ['file:', 'link:', 'workspace:', 'git:', 'http://', 'https://', 'github:']
const pathLike = /^[./]|\\/  // relative or drive-letter specifier
const offenders = []
for (const name of Object.keys(manifest.dependencies ?? {})) {
  const specifier = manifest.dependencies[name]
  const denied = deniedPrefixes.some((prefix) => String(specifier).startsWith(prefix))
  if (denied || pathLike.test(String(specifier))) offenders.push(`${name}@${specifier}`)
}
if (offenders.length > 0) {
  console.error(`non-public runtime dependency specifier(s):\n  ${offenders.join('\n  ')}`)
  process.exit(1)
}
console.log(`verify: ${Object.keys(manifest.dependencies ?? {}).length} runtime dependency specifier(s) are public`)
