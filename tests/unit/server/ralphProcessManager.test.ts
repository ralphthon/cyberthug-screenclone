import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ralphMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  watch: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  cp: vi.fn(),
  chmod: vi.fn(),
  writeFile: vi.fn(),
  stat: vi.fn(),
  open: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: ralphMocks.spawn,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');

  return {
    ...actual,
    watch: ralphMocks.watch,
    promises: {
      ...actual.promises,
      readdir: ralphMocks.readdir,
      mkdir: ralphMocks.mkdir,
      rm: ralphMocks.rm,
      cp: ralphMocks.cp,
      chmod: ralphMocks.chmod,
      writeFile: ralphMocks.writeFile,
      stat: ralphMocks.stat,
      open: ralphMocks.open,
    },
  };
});

type MockWatcher = EventEmitter & {
  close: ReturnType<typeof vi.fn>;
};

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

const createWatcher = (): MockWatcher => {
  const watcher = new EventEmitter() as MockWatcher;
  watcher.close = vi.fn();
  return watcher;
};

const createChild = (): MockChild => {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    void signal;
    child.killed = true;
    return true;
  });
  return child;
};

const importRalphProcessManager = async () => import('../../../src/server/ralphProcessManager.ts');
const waitForAsync = async () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RalphProcessManager', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    delete process.env.RALPH_MAX_SESSIONS;

    ralphMocks.readdir.mockResolvedValue(['shot.png']);
    ralphMocks.mkdir.mockResolvedValue(undefined);
    ralphMocks.rm.mockResolvedValue(undefined);
    ralphMocks.cp.mockResolvedValue(undefined);
    ralphMocks.chmod.mockResolvedValue(undefined);
    ralphMocks.writeFile.mockResolvedValue(undefined);
    ralphMocks.stat.mockResolvedValue({ size: 0 });
    ralphMocks.open.mockResolvedValue({
      read: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });
    ralphMocks.watch.mockImplementation(() => createWatcher() as unknown as import('node:fs').FSWatcher);
    ralphMocks.spawn.mockImplementation(() => createChild());
  });

  it('starts a session, updates status from output, and supports stop/shutdown lifecycle', async () => {
    const { RalphProcessManager } = await importRalphProcessManager();
    const manager = new RalphProcessManager();

    const started = await manager.start(' session-1 ', {
      projectName: 'Demo Clone',
      maxIterations: 3,
      targetSimilarity: 88,
    });

    expect(started.state).toBe('cloning');
    expect(started.currentIteration).toBe(0);
    expect(started.maxIterations).toBe(3);
    expect(started.startedAt).not.toBeNull();

    const child = ralphMocks.spawn.mock.results[0]?.value as MockChild;
    child.stdout.emit('data', 'Ralph Iteration 2 of 5\n');

    const statusAfterOutput = manager.getStatus('session-1');
    expect(statusAfterOutput.currentIteration).toBe(2);
    expect(statusAfterOutput.maxIterations).toBe(5);
    expect(manager.getOutput('session-1', 1)).toEqual(['[stdout] Ralph Iteration 2 of 5']);

    expect(manager.stop('session-1')).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emit('exit', null, 'SIGTERM');
    await waitForAsync();

    expect(manager.getStatus('session-1').state).toBe('failed');

    await manager.shutdown();
  });

  it('returns false when stopping an unknown session and throws for unknown status/output', async () => {
    const { RalphProcessManager } = await importRalphProcessManager();
    const manager = new RalphProcessManager();

    expect(manager.stop('missing')).toBe(false);
    expect(() => manager.getStatus('missing')).toThrow("Session 'missing' not found");
    expect(() => manager.getOutput('missing')).toThrow("Session 'missing' not found");
  });

  it('validates required start inputs', async () => {
    const { RalphProcessManager } = await importRalphProcessManager();
    const manager = new RalphProcessManager();

    await expect(manager.start('', { projectName: 'Demo', maxIterations: 1 })).rejects.toThrow('sessionId is required');
    await expect(manager.start('s1', { projectName: '   ', maxIterations: 1 })).rejects.toThrow('projectName is required');
    await expect(manager.start('s1', { projectName: 'Demo', maxIterations: 0 })).rejects.toThrow(
      'maxIterations must be a positive integer',
    );
    await expect(
      manager.start('s1', { projectName: 'Demo', maxIterations: 1, targetSimilarity: 101 }),
    ).rejects.toThrow('targetSimilarity must be between 0 and 100');
  });

  it('fails to start when images are unavailable', async () => {
    const { RalphProcessManager } = await importRalphProcessManager();
    const manager = new RalphProcessManager();

    ralphMocks.readdir.mockRejectedValueOnce(new Error('missing'));
    await expect(manager.start('s1', { projectName: 'Demo', maxIterations: 1 })).rejects.toThrow(
      "Session image directory '/tmp/ralphton-s1' not found",
    );

    ralphMocks.readdir.mockResolvedValueOnce(['readme.md']);
    await expect(manager.start('s2', { projectName: 'Demo', maxIterations: 1 })).rejects.toThrow(
      "No uploaded screenshots found in '/tmp/ralphton-s2'",
    );
  });

  it('enforces max concurrent sessions and duplicate running session protection', async () => {
    process.env.RALPH_MAX_SESSIONS = '1';

    const { RalphProcessManager } = await importRalphProcessManager();
    const manager = new RalphProcessManager();

    await manager.start('s1', { projectName: 'Demo', maxIterations: 2 });

    await expect(manager.start('s2', { projectName: 'Demo', maxIterations: 2 })).rejects.toThrow(
      'Maximum concurrent sessions reached (1)',
    );

    delete process.env.RALPH_MAX_SESSIONS;
    const { RalphProcessManager: AnotherManager } = await importRalphProcessManager();
    const managerTwo = new AnotherManager();
    await managerTwo.start('same', { projectName: 'Demo', maxIterations: 2 });

    await expect(managerTwo.start('same', { projectName: 'Demo', maxIterations: 2 })).rejects.toThrow(
      "Session 'same' is already running",
    );
  });
});
