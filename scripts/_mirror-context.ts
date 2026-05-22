/**
 * @fileoverview Minimal Context-shaped helper for mirror scripts (init/refresh).
 * Scripts run outside the MCP request pipeline; they don't have a real Context.
 * This helper exposes the `log` + `signal` surface that the harvest runner
 * consumes, wired to console output and a SIGINT-driven AbortController.
 * @module scripts/_mirror-context
 */

type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error';

function makeLogger(prefix: string) {
  const emit = (level: LogLevel, message: string, meta?: object): void => {
    const tag = `[${new Date().toISOString()}] ${level.toUpperCase()} ${prefix}`;
    const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const line = `${tag} ${message}${metaStr}`;
    if (level === 'error') console.error(line);
    else if (level === 'warning') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m: string, meta?: object) => emit('debug', m, meta),
    info: (m: string, meta?: object) => emit('info', m, meta),
    notice: (m: string, meta?: object) => emit('notice', m, meta),
    warning: (m: string, meta?: object) => emit('warning', m, meta),
    error: (m: string, meta?: object) => emit('error', m, meta),
  };
}

/**
 * Build a minimal Context-shaped object for use by mirror scripts. Wires
 * Ctrl+C / SIGTERM to the returned `signal` so a long harvest can be
 * interrupted cleanly — the runner persists `harvest_state` before exiting.
 */
export function makeScriptContext(prefix: string): {
  log: ReturnType<typeof makeLogger>;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  const onSignal = (sig: string) => () => {
    console.error(`\nReceived ${sig}; aborting harvest...`);
    controller.abort(new Error(`Aborted by ${sig}`));
  };
  process.once('SIGINT', onSignal('SIGINT'));
  process.once('SIGTERM', onSignal('SIGTERM'));
  return { log: makeLogger(prefix), signal: controller.signal };
}
