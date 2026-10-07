// Settings shared with the pi, opencode and Codex ports: `~/.config/agents/cache-guard.json` (or
// under $XDG_CONFIG_HOME) and `<project>/.agents/cache-guard.json`, with Claude Code's own
// `~/.claude/cache-guard.json` and `<project>/.claude/cache-guard.json` as overrides. Later files
// win; objects merge, other values replace.
import { NAME } from './core'

/** The settings files, lowest precedence first. */
export function settingsFiles(home: string, xdgConfigHome: string | undefined, root: string): string[] {
  const shared = xdgConfigHome || `${home}/.config`
  return [
    `${shared}/agents/${NAME}.json`,
    `${home}/.claude/${NAME}.json`,
    `${root}/.agents/${NAME}.json`,
    `${root}/.claude/${NAME}.json`,
  ]
}
