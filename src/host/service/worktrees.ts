import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SjsError } from './errors.ts'
import type { WorktreeRecord } from './types.ts'

/**
 * File-level worktree registry (host-only; no worker involved).
 *
 * A worktree is an isolated draft: a byte-for-byte snapshot of one committed
 * `.ssjson` workbook. `create` copies the base into a private draft file and
 * records the pair (base, draft, sha256-of-base) in a per-workspace registry.
 * Phase 1 never writes the base, so a draft can only ever diverge in its own
 * file; phase 2 will layer ready/merge/discard transitions on top of the same
 * records.
 */

/** WorktreeId accepted characters (safe path segment and JSON key). */
const WORKTREE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Registry JSON path for one workspace. */
export function worktreeRegistryPath(workspace: string): string {
  return join(workspace, '.spreadjs', 'worktrees.json')
}

/** Draft `.ssjson` file that backs one worktree (absolute). */
export function worktreeDraftPath(workspace: string, worktreeId: string): string {
  return join(workspace, '.spreadjs', 'drafts', `${worktreeId}.ssjson`)
}

/** Absolute base path for a registry record's workspace-relative `base`. */
export function worktreeBasePath(workspace: string, baseRelative: string): string {
  return resolve(workspace, baseRelative)
}

/** Path stored in a record is workspace-relative and always uses `/`. */
export function toWorkspaceRelative(workspace: string, absolutePath: string): string {
  const relativePath = relative(workspace, absolutePath)
  return relativePath.split(sep).join('/')
}

/** Read the registry of one workspace; a missing registry is an empty list. */
export async function readWorktreeRegistry(workspace: string): Promise<WorktreeRecord[]> {
  let text: string
  try {
    text = await readFile(worktreeRegistryPath(workspace), 'utf8')
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw new SjsError('worktree registry could not be read', 'FILE_PERMISSION_DENIED', { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new SjsError(
      'worktree registry is corrupted (not valid JSON); repair or remove .spreadjs/worktrees.json to continue',
      'INVALID_FILE_PATH',
      { cause: error },
    )
  }
  if (!Array.isArray(parsed)) {
    throw new SjsError(
      'worktree registry is corrupted (expected an array); repair or remove .spreadjs/worktrees.json to continue',
      'INVALID_FILE_PATH',
    )
  }
  return parsed.filter((entry): entry is WorktreeRecord => isWorktreeRecord(entry))
}

/** Persist the registry atomically (tmp file + rename). */
export async function writeWorktreeRegistry(workspace: string, records: WorktreeRecord[]): Promise<void> {
  const target = worktreeRegistryPath(workspace)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  } catch (error) {
    throw new SjsError('worktree registry could not be written', 'FILE_PERMISSION_DENIED', { cause: error })
  }
}

/** Compute a stable fingerprint of the committed base at branch time. */
async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath)
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Branch a new draft off `basePath` and record it. Throws instead of
 * overwriting on any collision; the base file is never written.
 */
export async function createWorktreeRecord(
  workspace: string,
  basePath: string,
  requestedId?: string,
): Promise<WorktreeRecord> {
  const registryDir = resolve(workspace, '.spreadjs')
  if (isWithin(basePath, registryDir)) {
    throw new SjsError('a worktree base must be a committed workbook, not a draft under .spreadjs', 'INVALID_FILE_PATH')
  }
  const existing = await readWorktreeRegistry(workspace)
  const taken = new Set(existing.map((record) => record.worktreeId))
  const stem = basename(basePath, extname(basePath))

  let worktreeId: string
  if (requestedId === undefined) {
    worktreeId = nextAvailableId(`${stem}.draft`, taken)
  } else {
    worktreeId = requestedId
    if (!WORKTREE_ID_PATTERN.test(worktreeId)) {
      throw new SjsError(
        `worktreeId must match ${WORKTREE_ID_PATTERN}, got ${JSON.stringify(worktreeId)}`,
        'INVALID_FILE_PATH',
      )
    }
    if (taken.has(worktreeId)) {
      throw new SjsError(`worktree ${JSON.stringify(worktreeId)} already exists in this workspace`, 'INVALID_FILE_PATH')
    }
  }

  const draftPath = worktreeDraftPath(workspace, worktreeId)
  await mkdir(dirname(draftPath), { recursive: true })
  try {
    // COPYFILE_EXCL: refuse to clobber an existing file (incl. a stale draft).
    await copyFile(basePath, draftPath, constants.COPYFILE_EXCL)
  } catch (error) {
    if (isExistsError(error)) {
      throw new SjsError(`draft target already exists: ${draftPath}`, 'INVALID_FILE_PATH', { cause: error })
    }
    throw new SjsError('worktree draft could not be created', 'FILE_PERMISSION_DENIED', { cause: error })
  }

  const record: WorktreeRecord = {
    worktreeId,
    base: toWorkspaceRelative(workspace, basePath),
    draft: toWorkspaceRelative(workspace, draftPath),
    status: 'editing',
    baseSha256: await sha256File(basePath),
    createdAt: new Date().toISOString(),
  }
  try {
    await writeWorktreeRegistry(workspace, [...existing, record])
  } catch (error) {
    // Best-effort rollback of the orphan draft so a failed create leaves no file.
    await rmDraftQuietly(draftPath)
    throw error
  }
  return record
}

/** Append `-2`, `-3`, … until an id not already taken is found. */
function nextAvailableId(preferred: string, taken: ReadonlySet<string>): string {
  if (!taken.has(preferred)) return preferred
  for (let suffix = 2; ; suffix++) {
    const candidate = `${preferred}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

async function rmDraftQuietly(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true })
  } catch {
    // Nothing left to do; a stray file is preferable to a false failure report.
  }
}

/** True when `candidate` equals `dir` or lives beneath it. */
function isWithin(candidate: string, dir: string): boolean {
  const fromDir = relative(dir, candidate)
  return fromDir === '' || (fromDir !== '..' && !fromDir.startsWith(`..${sep}`) && !isAbsolute(fromDir))
}

function isWorktreeRecord(value: unknown): value is WorktreeRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.worktreeId === 'string' &&
    typeof record.base === 'string' &&
    typeof record.draft === 'string' &&
    typeof record.status === 'string' &&
    typeof record.baseSha256 === 'string' &&
    typeof record.createdAt === 'string'
  )
}

function isMissingPathError(error: unknown): boolean {
  return nodeErrorCode(error) === 'ENOENT'
}

function isExistsError(error: unknown): boolean {
  return nodeErrorCode(error) === 'EEXIST'
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
