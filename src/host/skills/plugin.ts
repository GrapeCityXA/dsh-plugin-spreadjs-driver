import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'spreadjs'
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DEFINITIONS = [
  {
    name: 'spreadjs',
    description:
      'Create, inspect, edit, import, export, and screenshot .ssjson SpreadJS workbooks through the sjs_* DSH tools. Use proactively for any spreadsheet task — building or editing tables, cells, formulas, sheets, formatting; reading or writing .xlsx / .csv files; producing a .pdf or .png visual snapshot; or running SpreadJS JavaScript through sjs_execute for anything the narrow tools cannot express.',
  },
] as const

/**
 * Bundle the orchestration skill so DSH can present it to agents. DSH never
 * scans an installed plugin's `skills/` directory on its own — a plugin must
 * register a skill provider whose locators point at its own bundled SKILL.md
 * (same convention as the reference office plugin). The compiled module lives
 * at <package>/lib/index.js, so `../skills/<name>/SKILL.md` resolves to the
 * package root `skills/` shipped in the tarball.
 */
const CANDIDATES: readonly SkillCandidate[] = DEFINITIONS.map((definition) => {
  const url = new URL(`../skills/${definition.name}/SKILL.md`, import.meta.url)
  return {
    ...definition,
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL(`../skills/${definition.name}/`, import.meta.url)) },
    rank: BUNDLED_SKILL_RANK,
    locator: url,
  }
})

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve(CANDIDATES),
  async get(candidate): Promise<SkillDefinition> {
    if (!(candidate.locator instanceof URL)) throw new Error('spreadjs skill locator must be a URL')
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      provider: candidate.provider,
      source: candidate.source,
      ...(candidate.resourceBase === undefined ? {} : { resourceBase: candidate.resourceBase }),
      content: stripFrontmatter(await readFile(candidate.locator, 'utf8')),
    }
  },
}

export const name = 'spreadjs-skills'
export const inject = ['skills']

/** Register bundled spreadjs instructions on the DSH skill seam. */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}

function stripFrontmatter(value: string): string {
  if (!value.startsWith('---\n')) return value
  const end = value.indexOf('\n---\n', 4)
  return end === -1 ? value : value.slice(end + 5)
}
