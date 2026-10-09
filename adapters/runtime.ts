/** The production effects of the Codex and Muse Code adapters. */
import { spawn } from 'node:child_process'
import { mkdir, open, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { JevAnswer } from '../core/check'
import { EXTRACTION_TIMEOUT_MS, JEV_URL } from '../core/rules'
import type { AdapterDependencies } from './check'
import type { Extraction } from './contracts'
import { appendJsonLine, hasCode, readText, writeText } from './files'

/** An extraction lease older than this belongs to a process that died. */
export const LEASE_MS = EXTRACTION_TIMEOUT_MS + 60_000

/** The lease file that marks an extraction in progress for `cachePath`. */
export function leaseFile(cachePath: string): string {
  return `${cachePath}.pending`
}

/** Whether a fresh lease exists, that is, whether an extraction is running. */
export async function isLeased(cachePath: string, now: number): Promise<boolean> {
  try {
    const metadata = await stat(leaseFile(cachePath))

    return now - metadata.mtimeMs < LEASE_MS
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
}

/** Sends one request to Jev; the abort covers the request and the response body. */
export async function jev(
  body: string,
  timeoutMs: number,
  key: string,
  url: string = JEV_URL,
): Promise<JevAnswer> {
  const started = performance.now()
  const latency = () => Math.round(performance.now() - started)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)

      return {
        kind: 'error',
        detail: `HTTP ${response.status}`,
        latencyMs: latency(),
      }
    }

    return { kind: 'answered', body: await response.text(), latencyMs: latency() }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError')
      return { kind: 'timeout', latencyMs: latency() }

    return {
      kind: 'error',
      detail: `request failed: ${String(error)}`,
      latencyMs: latency(),
    }
  }
}

/**
 * Takes the lease with an exclusive create and starts the extractor as a
 * detached process that outlives the hook. A lease older than six minutes
 * is replaced.
 */
export async function extract(job: Extraction): Promise<boolean> {
  const lease = leaseFile(job.cachePath)
  await mkdir(dirname(lease), { recursive: true })
  if (!(await isLeased(job.cachePath, Date.now())))
    await unlink(lease).catch((error: unknown) => {
      if (!hasCode(error, 'ENOENT')) throw error
    })
  try {
    const handle = await open(lease, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return false
    throw error
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--no-env-file', `${import.meta.dir}/extract.ts`],
        {
          cwd: import.meta.dir,
          detached: true,
          stdio: ['pipe', 'ignore', 'ignore'],
        },
      )
      child.once('error', reject)
      child.stdin.on('error', reject)
      child.once('spawn', () => {
        child.stdin.end(JSON.stringify(job))
        child.unref()
        resolve()
      })
    })
  } catch (error) {
    await unlink(lease).catch(() => undefined)
    throw error
  }

  return true
}

/** The effects every adapter command uses. */
export const runtime: AdapterDependencies = {
  read: readText,
  write: writeText,
  append: appendJsonLine,
  extract,
  jev: (body, timeoutMs, key) => jev(body, timeoutMs, key),
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
}
