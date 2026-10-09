/**
 * The check's progress in the current main-loop turn. `rewrites` counts the
 * rewrites this plugin requested; `violations` holds the rules the final reply
 * still broke after the rewrite, or is empty.
 */
export interface ProseCheckTurn {
  rewrites: number
  violations: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'prose-check': { turn: ProseCheckTurn }
  }
}
