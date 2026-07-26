/**
 * @fileoverview Tests for the mirror refresh subprocess offload (issue #22) —
 * the parent spawn supervisor (`runRefreshSubprocess`) and the child harvest
 * body (`runRefreshChild`). `node:child_process` and the harvest runner are
 * mocked so the supervisor's wiring (spawn args, log forwarding, exit handling,
 * timeout escalation, concurrency guard) is exercised without a real process.
 * @module services/arxiv/mirror/refresh-subprocess.test
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runRefreshChild,
  runRefreshSubprocess,
} from '@/services/arxiv/mirror/refresh-subprocess.js';
import { runHarvest } from '@/services/arxiv/mirror/runner.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('@/services/arxiv/mirror/runner.js', () => ({ runHarvest: vi.fn() }));

const spawnMock = vi.mocked(spawn);
const runHarvestMock = vi.mocked(runHarvest);

/** A fake ChildProcess with controllable stdout/stderr/exit. */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: () => void };
    stderr: EventEmitter & { setEncoding: () => void };
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: () => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: () => void };
  stderr.setEncoding = () => {};
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  return child;
}

function makeLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  };
}

describe('runRefreshSubprocess', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns the compiled child entry with the current runtime and piped stdio', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe(process.execPath);
    expect(args?.[0]).toMatch(/refresh-subprocess\.js$/);
    expect((opts as { stdio: unknown }).stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect((opts as { env: unknown }).env).toBe(process.env);

    child.exitCode = 0;
    child.emit('exit', 0, null);
    await expect(done).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      'Mirror refresh subprocess completed',
      expect.objectContaining({ code: 0 }),
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('rejects on a non-zero exit so the scheduler records the tick as failed (#31)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await expect(done).rejects.toThrow(/exited with code 1/);
    expect(log.error).toHaveBeenCalledWith(
      'Mirror refresh subprocess exited non-zero',
      expect.objectContaining({ code: 1 }),
    );
  });

  it('rejects when the child fails to spawn (#31)', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const log = makeLog();

    await expect(runRefreshSubprocess({ timeoutMs: 1000, log })).rejects.toThrow(/failed to spawn/);
    expect(log.error).toHaveBeenCalledWith(
      'Mirror refresh subprocess failed to spawn',
      expect.objectContaining({ error: 'EACCES' }),
    );
  });

  it('rejects when the child emits an error event (#31)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    child.emit('error', new Error('spawn ENOENT'));
    await expect(done).rejects.toThrow(/spawn ENOENT/);
    expect(log.error).toHaveBeenCalledWith('Mirror refresh subprocess error', {
      error: 'spawn ENOENT',
    });
  });

  it('releases the concurrency guard after a failed run (#31)', async () => {
    // The rejection must not strand `activeChild`, or every later tick is
    // skipped as "already running".
    const first = makeFakeChild();
    spawnMock.mockReturnValue(first as unknown as ChildProcess);
    const log = makeLog();

    const failed = runRefreshSubprocess({ timeoutMs: 1000, log });
    first.emit('exit', 1, null);
    await expect(failed).rejects.toThrow();

    const second = makeFakeChild();
    spawnMock.mockReturnValue(second as unknown as ChildProcess);
    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    second.emit('exit', 0, null);
    await expect(done).resolves.toBeUndefined();
  });

  it('is a no-op when a refresh is already running', async () => {
    const first = makeFakeChild();
    spawnMock.mockReturnValue(first as unknown as ChildProcess);
    const log = makeLog();

    const done1 = runRefreshSubprocess({ timeoutMs: 1000, log });
    const done2 = runRefreshSubprocess({ timeoutMs: 1000, log });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(log.warning).toHaveBeenCalledWith('Mirror refresh already running; skipping this tick');
    await expect(done2).resolves.toBeUndefined();

    first.emit('exit', 0, null);
    await done1;
  });

  it('escalates SIGTERM then SIGKILL when the child overruns the timeout', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    vi.advanceTimersByTime(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    vi.advanceTimersByTime(30_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('exit', null, 'SIGKILL');
    // A harvest killed mid-flight is a failed tick, not a completed one (#31).
    await expect(done).rejects.toThrow(/terminated on timeout/);
    expect(log.error).toHaveBeenCalledWith(
      'Mirror refresh subprocess terminated on timeout',
      expect.objectContaining({ signal: 'SIGKILL' }),
    );
  });

  it('relays a structured child stdout line at its original level', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    child.stdout.emit('data', `${JSON.stringify({ level: 'info', msg: 'page', pages: 3 })}\n`);
    expect(log.info).toHaveBeenCalledWith('page', { pages: 3 });

    child.emit('exit', 0, null);
    await done;
  });

  it('forwards a raw child stderr line at error level', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    child.stderr.emit('data', 'segfault in native module\n');
    expect(log.error).toHaveBeenCalledWith('segfault in native module');

    child.emit('exit', 1, null);
    await expect(done).rejects.toThrow();
  });
});

describe('runRefreshChild', () => {
  beforeEach(() => {
    runHarvestMock.mockReset();
  });

  it('runs an incremental refresh and logs completion', async () => {
    const result = {
      pagesFetched: 2,
      recordsApplied: 10,
      tombstonesApplied: 0,
      totalRecords: 100,
    };
    runHarvestMock.mockResolvedValue(result);
    const log = makeLog();
    const controller = new AbortController();

    await runRefreshChild(log, controller.signal);

    expect(runHarvestMock).toHaveBeenCalledWith(
      { log, signal: controller.signal },
      { mode: 'refresh' },
    );
    expect(log.info).toHaveBeenCalledWith('Mirror refresh complete', result);
  });

  it('propagates a harvest failure to the caller', async () => {
    runHarvestMock.mockRejectedValue(new Error('OAI unreachable'));
    const log = makeLog();
    await expect(runRefreshChild(log, new AbortController().signal)).rejects.toThrow(
      'OAI unreachable',
    );
  });
});
