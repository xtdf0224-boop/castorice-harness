'use strict';
// Environment for "Claude Code pointed at a vendor's Anthropic-compatible endpoint" (the claude-compat driver, MODELS-SPEC §10.9).
// It used to be assembled in the page (live.ts + models.ts, twice); now only the main process builds it, from the registry's own
// endpoint address, so a page can never aim a stored key at another host. The key itself is added by the caller (index.cjs),
// which also wraps the stream in the scrubber.
//
// Nothing here touches Electron or the disk: the caller passes the config directory in.

const ONE_M = 1_000_000;
/** The 'main' model name: Claude Code asks for a 1M window with a [1m] suffix, as the vendors' own guides do. */
const withWindow = (model, big) => (big && !/\[1m\]$/i.test(model) ? `${model}[1m]` : model);

/**
 * @param {{ url: string, model: string, ctx?: { tokens: number, known: boolean }, autoCompactWindow?: number, configDir: string }} a
 * @returns {Record<string, string>} everything except ANTHROPIC_AUTH_TOKEN
 */
function buildCompatEnv(a) {
  const model = a.model;
  const big = !!a.ctx && a.ctx.known && a.ctx.tokens >= ONE_M;
  const main = withWindow(model, big);
  const env = {
    ANTHROPIC_BASE_URL: a.url,
    ANTHROPIC_MODEL: main,
    // Every slot is pinned: each vendor's guide stresses that unpinned small/subagent slots fail silently
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: main,
    API_TIMEOUT_MS: '600000',
    // Another vendor's endpoint: its sessions and settings stay apart from the user's own Claude Code…
    CLAUDE_CONFIG_DIR: a.configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // …and the user's own Anthropic credentials are never forwarded to it
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
  };
  if (Number.isInteger(a.autoCompactWindow) && a.autoCompactWindow > 0) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(a.ctx && a.ctx.known ? Math.min(a.autoCompactWindow, a.ctx.tokens) : a.autoCompactWindow);
  else if (a.ctx && a.ctx.known) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Math.min(a.ctx.tokens, ONE_M));
  return env;
}

module.exports = { buildCompatEnv, withWindow };
