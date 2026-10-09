/** The background extractor's entry point: one extraction job on standard input. */
import { parseExtraction } from './contracts'
import { parseJson } from './files'
import { runExtraction } from './extraction'

const job = parseExtraction(parseJson(await Bun.stdin.text()))
process.exitCode = job !== undefined && (await runExtraction(job)) ? 0 : 1
