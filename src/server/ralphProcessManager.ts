import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AnalysisResult } from './visionAnalyzer.js';

export type RalphSessionState = 'idle' | 'uploading' | 'analyzing' | 'cloning' | 'completed' | 'failed';

export type RalphStartConfig = {
  projectName: string;
  maxIterations: number;
  targetSimilarity?: number;
  analysis?: AnalysisResult;
};

export type RalphSessionStatus = {
  state: RalphSessionState;
  currentIteration: number;
  maxIterations: number;
  lastScore: number | null;
  startedAt: string | null;
  elapsedMs: number;
};

export type RalphIterationCompleteEvent = {
  sessionId: string;
  iteration: number;
  score: number | null;
  chunk: string;
};

type SessionRuntime = {
  sessionId: string;
  state: RalphSessionState;
  maxIterations: number;
  currentIteration: number;
  lastScore: number | null;
  startedAtMs: number | null;
  startedAtIso: string | null;
  child: ChildProcessWithoutNullStreams | null;
  outputRingBuffer: string[];
  outputRemainderByStream: Record<'stdout' | 'stderr', string>;
  progressWatcher: FSWatcher | null;
  progressOffsetBytes: number;
  readingProgress: boolean;
  finalized: boolean;
  stopRequested: boolean;
  workspaceDir: string;
  runtimeDir: string;
  progressFilePath: string;
  sessionImagesDir: string;
};

const TMP_ROOT = '/tmp';
const SESSION_DIR_PREFIX = 'ralphton-';
const OUTPUT_RING_BUFFER_SIZE = 500;
const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const RALPH_ITERATION_REGEX = /Ralph Iteration\s+(\d+)\s+of\s+(\d+)/i;

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
};

const slugify = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'screenclone-session';
};

const createEmptyRuntime = (sessionId: string): SessionRuntime => {
  const sessionImagesDir = path.join(TMP_ROOT, `${SESSION_DIR_PREFIX}${sessionId}`);
  const workspaceDir = path.join(sessionImagesDir, 'workspace');
  const runtimeDir = path.join(workspaceDir, 'ralph-runtime');
  const progressFilePath = path.join(runtimeDir, 'progress.txt');

  return {
    sessionId,
    state: 'idle',
    maxIterations: 0,
    currentIteration: 0,
    lastScore: null,
    startedAtMs: null,
    startedAtIso: null,
    child: null,
    outputRingBuffer: [],
    outputRemainderByStream: {
      stdout: '',
      stderr: '',
    },
    progressWatcher: null,
    progressOffsetBytes: 0,
    readingProgress: false,
    finalized: false,
    stopRequested: false,
    workspaceDir,
    runtimeDir,
    progressFilePath,
    sessionImagesDir,
  };
};

type SessionPrd = {
  project: string;
  branchName: string;
  description: string;
  userStories: Array<{
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    priority: number;
    passes: boolean;
    status: 'pending';
  }>;
};

const buildSessionPrd = (sessionId: string, config: RalphStartConfig): SessionPrd => {
  const targetScore = Number.isFinite(config.targetSimilarity) ? Math.round(config.targetSimilarity!) : 90;
  const maxIterations = config.maxIterations;
  const analysis = config.analysis;

  const analysisCriteria: string[] = [];
  if (analysis) {
    const sectionSummary = analysis.layout.sections.length > 0 ? analysis.layout.sections.join(', ') : 'main';
    const componentSummary =
      analysis.components.length > 0
        ? analysis.components.map((component) => component.type).slice(0, 10).join(', ')
        : 'core layout components';
    analysisCriteria.push(
      `Layout should reflect a ${analysis.layout.type}/${analysis.layout.direction} structure with sections: ${sectionSummary}.`,
    );
    analysisCriteria.push(`Component inventory should include: ${componentSummary}.`);
    analysisCriteria.push(
      `Color palette should stay close to ${analysis.colorPalette.primary}, ${analysis.colorPalette.secondary}, ${analysis.colorPalette.background}, ${analysis.colorPalette.text}, ${analysis.colorPalette.accent}.`,
    );
    if (analysis.textContent.length > 0) {
      analysisCriteria.push(`Key text content should include: ${analysis.textContent.slice(0, 8).join(' | ')}.`);
    }
    if (analysis.fonts.length > 0) {
      analysisCriteria.push(`Typography should resemble: ${analysis.fonts.slice(0, 5).join(', ')}.`);
    }
  }

  return {
    project: config.projectName,
    branchName: `ralph/${slugify(config.projectName)}-${sessionId.slice(0, 8)}`,
    description: `Autonomous screenshot clone session for ${config.projectName} (${sessionId}).`,
    userStories: [
      {
        id: 'US-SESSION-001',
        title: 'Clone uploaded screenshot',
        description:
          'As a user, I want the generated website output to match the uploaded reference screenshot so that the clone can ship as a production-ready baseline.',
        acceptanceCriteria: [
          `Use ralph loop iterations to improve visual similarity toward ${targetScore}% or better.`,
          ...analysisCriteria,
          `Stop after ${maxIterations} iterations if target score is not reached.`,
          'Generated HTML/CSS/JS should remain renderable and typecheck/build clean after each iteration.',
        ],
        priority: 1,
        passes: false,
        status: 'pending',
      },
    ],
  };
};

const buildInitialProgressLog = (sessionId: string, config: RalphStartConfig): string => {
  return [
    '## Codebase Patterns',
    '- Keep one story per iteration and append progress entries instead of rewriting history.',
    '- Use visual-verdict feedback from progress log as the primary fix signal for next iteration.',
    '',
    `## ${new Date().toISOString()} - Session Start`,
    `- Session ID: ${sessionId}`,
    `- Project: ${config.projectName}`,
    `- Max iterations: ${config.maxIterations}`,
    `- Target similarity: ${config.targetSimilarity ?? 90}%`,
    '- State initialized by RalphProcessManager.',
    '---',
    '',
  ].join('\n');
};

export class RalphProcessManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly maxConcurrentSessions: number;
  private readonly ralphTemplateDir: string;

  constructor() {
    super();
    this.maxConcurrentSessions = parsePositiveInteger(
      process.env.RALPH_MAX_SESSIONS,
      DEFAULT_MAX_CONCURRENT_SESSIONS,
    );
    this.ralphTemplateDir = path.resolve(process.cwd(), 'scripts/ralph');
  }

  public async start(sessionId: string, config: RalphStartConfig): Promise<RalphSessionStatus> {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) {
      throw new Error('sessionId is required');
    }

    this.validateStartConfig(config);

    if (this.getActiveSessionCount() >= this.maxConcurrentSessions) {
      throw new Error(`Maximum concurrent sessions reached (${this.maxConcurrentSessions})`);
    }

    const existing = this.sessions.get(trimmedSessionId);
    if (existing && (existing.state === 'cloning' || existing.state === 'uploading' || existing.state === 'analyzing')) {
      throw new Error(`Session '${trimmedSessionId}' is already running`);
    }

    const runtime = createEmptyRuntime(trimmedSessionId);
    runtime.maxIterations = config.maxIterations;
    this.sessions.set(trimmedSessionId, runtime);
    this.setState(runtime, 'uploading');

    await this.ensureSessionImagesExist(runtime.sessionImagesDir);

    this.setState(runtime, 'analyzing');
    await this.prepareRuntimeWorkspace(runtime, config);

    this.setState(runtime, 'cloning');
    runtime.startedAtMs = Date.now();
    runtime.startedAtIso = new Date(runtime.startedAtMs).toISOString();
    runtime.currentIteration = 0;
    runtime.lastScore = null;
    runtime.stopRequested = false;
    runtime.finalized = false;

    await this.startProgressWatch(runtime);
    runtime.child = this.spawnRalphProcess(runtime);

    return this.getStatus(trimmedSessionId);
  }

  public stop(sessionId: string): boolean {
    const runtime = this.sessions.get(sessionId);
    if (!runtime || !runtime.child) {
      return false;
    }

    runtime.stopRequested = true;
    if (!runtime.child.killed) {
      runtime.child.kill('SIGTERM');
      setTimeout(() => {
        if (runtime.child && !runtime.child.killed) {
          const pid = runtime.child.pid;
          if (pid) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              // Process group may already be gone.
            }
          }
          runtime.child.kill('SIGKILL');
        }
      }, 10_000).unref();
    }

    return true;
  }

  public getStatus(sessionId: string): RalphSessionStatus {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    return {
      state: runtime.state,
      currentIteration: runtime.currentIteration,
      maxIterations: runtime.maxIterations,
      lastScore: runtime.lastScore,
      startedAt: runtime.startedAtIso,
      elapsedMs: runtime.startedAtMs ? Date.now() - runtime.startedAtMs : 0,
    };
  }

  public getOutput(sessionId: string, lastN = OUTPUT_RING_BUFFER_SIZE): string[] {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const count = Math.max(1, Math.min(lastN, OUTPUT_RING_BUFFER_SIZE));
    return runtime.outputRingBuffer.slice(-count);
  }

  public async shutdown(): Promise<void> {
    const pendingStops = Array.from(this.sessions.values()).map(async (runtime) => {
      if (runtime.child && !runtime.child.killed) {
        runtime.stopRequested = true;
        runtime.child.kill('SIGTERM');
        setTimeout(() => {
          if (runtime.child && !runtime.child.killed) {
            const pid = runtime.child.pid;
            if (pid) {
              try {
                process.kill(-pid, 'SIGKILL');
              } catch {
                // Process group may already be gone.
              }
            }
            runtime.child.kill('SIGKILL');
          }
        }, 10_000).unref();
      }

      await this.stopProgressWatch(runtime);
    });

    await Promise.all(pendingStops);
  }

  private getActiveSessionCount(): number {
    let activeCount = 0;

    for (const runtime of this.sessions.values()) {
      if (runtime.state === 'uploading' || runtime.state === 'analyzing' || runtime.state === 'cloning') {
        activeCount += 1;
      }
    }

    return activeCount;
  }

  private validateStartConfig(config: RalphStartConfig): void {
    if (!config.projectName || config.projectName.trim().length === 0) {
      throw new Error('projectName is required');
    }

    if (!Number.isInteger(config.maxIterations) || config.maxIterations <= 0) {
      throw new Error('maxIterations must be a positive integer');
    }

    if (
      config.targetSimilarity !== undefined &&
      (!Number.isFinite(config.targetSimilarity) || config.targetSimilarity < 0 || config.targetSimilarity > 100)
    ) {
      throw new Error('targetSimilarity must be between 0 and 100');
    }
  }

  private async ensureSessionImagesExist(sessionImagesDir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(sessionImagesDir);
    } catch {
      throw new Error(`Session image directory '${sessionImagesDir}' not found`);
    }

    const hasImage = entries.some((entry) => IMAGE_EXTENSIONS.has(path.extname(entry).toLowerCase()));
    if (!hasImage) {
      throw new Error(`No uploaded screenshots found in '${sessionImagesDir}'`);
    }
  }

  private async prepareRuntimeWorkspace(runtime: SessionRuntime, config: RalphStartConfig): Promise<void> {
    await fs.mkdir(runtime.workspaceDir, { recursive: true });
    await fs.rm(runtime.runtimeDir, { recursive: true, force: true });
    await fs.cp(this.ralphTemplateDir, runtime.runtimeDir, { recursive: true });

    const scriptPath = path.join(runtime.runtimeDir, 'ralph.sh');
    await fs.chmod(scriptPath, 0o755);

    const prdData = buildSessionPrd(runtime.sessionId, config);
    const progressData = buildInitialProgressLog(runtime.sessionId, config);

    await fs.writeFile(path.join(runtime.runtimeDir, 'prd.json'), `${JSON.stringify(prdData, null, 2)}\n`, 'utf8');
    await fs.writeFile(runtime.progressFilePath, progressData, 'utf8');
  }

  private async startProgressWatch(runtime: SessionRuntime): Promise<void> {
    const stats = await fs.stat(runtime.progressFilePath);
    runtime.progressOffsetBytes = stats.size;

    runtime.progressWatcher = watch(runtime.progressFilePath, () => {
      void this.readProgressAppend(runtime);
    });

    runtime.progressWatcher.on('error', (error) => {
      this.emit('loop-error', {
        sessionId: runtime.sessionId,
        error: error instanceof Error ? error.message : 'progress-watch-error',
        iteration: runtime.currentIteration,
        lastScore: runtime.lastScore,
      });
    });
  }

  private async stopProgressWatch(runtime: SessionRuntime): Promise<void> {
    if (runtime.progressWatcher) {
      runtime.progressWatcher.close();
      runtime.progressWatcher = null;
    }
  }

  private async readProgressAppend(runtime: SessionRuntime): Promise<void> {
    if (runtime.readingProgress) {
      return;
    }

    runtime.readingProgress = true;
    const MAX_PROGRESS_READ = 1024 * 1024;
    try {
      while (true) {
        const stats = await fs.stat(runtime.progressFilePath);
        if (stats.size < runtime.progressOffsetBytes) {
          runtime.progressOffsetBytes = 0;
        }

        const unreadBytes = Math.min(stats.size - runtime.progressOffsetBytes, MAX_PROGRESS_READ);
        if (unreadBytes <= 0) {
          break;
        }

        const readStartOffset = runtime.progressOffsetBytes;
        const handle = await fs.open(runtime.progressFilePath, 'r');
        try {
          const buffer = Buffer.alloc(unreadBytes);
          await handle.read(buffer, 0, unreadBytes, readStartOffset);
          runtime.progressOffsetBytes = readStartOffset + unreadBytes;
          this.parseProgressChunk(runtime, buffer.toString('utf8'));
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      console.warn('[RalphProcessManager] Failed to read progress append', {
        sessionId: runtime.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      runtime.readingProgress = false;
    }
  }

  private parseProgressChunk(runtime: SessionRuntime, chunk: string): void {
    if (chunk.includes('[AUTO_EVAL]')) {
      return;
    }

    const iteration = this.parseIterationFromChunk(chunk) ?? runtime.currentIteration;
    const score = this.parseScoreFromChunk(chunk);

    if (iteration > runtime.currentIteration) {
      runtime.currentIteration = iteration;
    }

    if (score !== null) {
      runtime.lastScore = score;
    }

    const iterationContextRegex = /iteration/i;
    const hasIterationContext = iterationContextRegex.test(chunk);
    if (hasIterationContext || score !== null) {
      const eventPayload: RalphIterationCompleteEvent = {
        sessionId: runtime.sessionId,
        iteration: runtime.currentIteration,
        score: runtime.lastScore,
        chunk,
      };
      this.emit('iteration-complete', eventPayload);
    }
  }

  private parseIterationFromChunk(chunk: string): number | null {
    const directMatch = RALPH_ITERATION_REGEX.exec(chunk);
    if (directMatch) {
      const parsedIteration = Number(directMatch[1]);
      if (Number.isInteger(parsedIteration) && parsedIteration > 0) {
        return parsedIteration;
      }
    }

    const iterationInProgressRegex = /iteration(?:\s*#|\s+)(\d+)/gi;
    let iterationMatch: RegExpExecArray | null = iterationInProgressRegex.exec(chunk);
    let bestIteration: number | null = null;
    while (iterationMatch) {
      const parsed = Number(iterationMatch[1]);
      if (Number.isInteger(parsed) && parsed > 0) {
        bestIteration = bestIteration === null ? parsed : Math.max(bestIteration, parsed);
      }

      iterationMatch = iterationInProgressRegex.exec(chunk);
    }

    return bestIteration;
  }

  private parseScoreFromChunk(chunk: string): number | null {
    const scoreValues: number[] = [];

    const scoreLineRegex = /Score:\s*([0-9]+(?:\.[0-9]+)?)(?:\s*\/\s*100)?/gi;
    let scoreMatch = scoreLineRegex.exec(chunk);
    while (scoreMatch) {
      const parsed = Number(scoreMatch[1]);
      if (Number.isFinite(parsed)) {
        scoreValues.push(parsed);
      }
      scoreMatch = scoreLineRegex.exec(chunk);
    }

    if (scoreValues.length > 0) {
      return scoreValues[scoreValues.length - 1];
    }

    const percentageRegex = /([0-9]+(?:\.[0-9]+)?)\s*%/g;
    let percentMatch = percentageRegex.exec(chunk);
    while (percentMatch) {
      const parsed = Number(percentMatch[1]);
      if (Number.isFinite(parsed)) {
        scoreValues.push(parsed);
      }
      percentMatch = percentageRegex.exec(chunk);
    }

    if (scoreValues.length === 0) {
      return null;
    }

    return scoreValues[scoreValues.length - 1];
  }

  private spawnRalphProcess(runtime: SessionRuntime): ChildProcessWithoutNullStreams {
    const scriptPath = path.join(runtime.runtimeDir, 'ralph.sh');
    const args = ['--tool', 'omx', '--images-dir', runtime.sessionImagesDir, String(runtime.maxIterations)];

    const child = spawn(scriptPath, args, {
      cwd: runtime.workspaceDir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        TERM: process.env.TERM,
        NODE_ENV: process.env.NODE_ENV,
        SHELL: process.env.SHELL,
      },
      stdio: 'pipe',
    });

    child.stdout.on('data', (chunk: Buffer | string) => {
      this.handleOutputChunk(runtime, chunk, 'stdout');
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      this.handleOutputChunk(runtime, chunk, 'stderr');
    });

    child.once('exit', (code, signal) => {
      void this.handleProcessExit(runtime, code, signal);
    });

    child.once('error', (error) => {
      this.finalize(runtime, 'failed', `Process spawn failed: ${error.message}`);
    });

    return child;
  }

  private handleOutputChunk(runtime: SessionRuntime, chunk: Buffer | string, stream: 'stdout' | 'stderr'): void {
    const chunkText = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const outputWithRemainder = `${runtime.outputRemainderByStream[stream]}${chunkText}`;
    const lines = outputWithRemainder.split(/\r?\n/);
    runtime.outputRemainderByStream[stream] = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }

      this.pushOutput(runtime, `[${stream}] ${line}`);

      const iterationMatch = line.match(RALPH_ITERATION_REGEX);
      if (iterationMatch) {
        const parsedIteration = Number(iterationMatch[1]);
        const parsedMaxIterations = Number(iterationMatch[2]);

        if (Number.isInteger(parsedIteration) && parsedIteration > 0) {
          runtime.currentIteration = parsedIteration;
        }
        if (Number.isInteger(parsedMaxIterations) && parsedMaxIterations > 0) {
          runtime.maxIterations = parsedMaxIterations;
        }

        this.emit('iteration-start', {
          sessionId: runtime.sessionId,
          iteration: runtime.currentIteration,
          maxIterations: runtime.maxIterations,
        });
      }
    }

    if (chunkText.includes('<promise>COMPLETE</promise>')) {
      this.finalize(runtime, 'completed', 'completion-marker-detected');
    }
  }

  private pushOutput(runtime: SessionRuntime, line: string): void {
    runtime.outputRingBuffer.push(line);
    if (runtime.outputRingBuffer.length > OUTPUT_RING_BUFFER_SIZE) {
      runtime.outputRingBuffer.splice(0, runtime.outputRingBuffer.length - OUTPUT_RING_BUFFER_SIZE);
    }
  }

  private async handleProcessExit(
    runtime: SessionRuntime,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (runtime.outputRemainderByStream.stdout.trim()) {
      this.pushOutput(runtime, `[stdout] ${runtime.outputRemainderByStream.stdout.trim()}`);
      runtime.outputRemainderByStream.stdout = '';
    }

    if (runtime.outputRemainderByStream.stderr.trim()) {
      this.pushOutput(runtime, `[stderr] ${runtime.outputRemainderByStream.stderr.trim()}`);
      runtime.outputRemainderByStream.stderr = '';
    }

    await this.stopProgressWatch(runtime);

    if (runtime.finalized) {
      runtime.child = null;
      return;
    }

    if (runtime.stopRequested) {
      this.finalize(runtime, 'failed', `stopped-by-request (${signal ?? 'SIGTERM'})`);
    } else if (code === 0) {
      this.finalize(runtime, 'failed', 'process-exited-without-completion-marker');
    } else {
      this.finalize(runtime, 'failed', `process-exit-${code ?? 'null'}-${signal ?? 'none'}`);
    }

    runtime.child = null;
  }

  private setState(runtime: SessionRuntime, nextState: RalphSessionState): void {
    runtime.state = nextState;
    this.emit('state-change', {
      sessionId: runtime.sessionId,
      state: nextState,
      currentIteration: runtime.currentIteration,
      maxIterations: runtime.maxIterations,
      lastScore: runtime.lastScore,
    });
  }

  private finalize(runtime: SessionRuntime, nextState: 'completed' | 'failed', reason: string): void {
    if (runtime.finalized) {
      return;
    }

    runtime.finalized = true;
    this.setState(runtime, nextState);
    setTimeout(() => {
      this.sessions.delete(runtime.sessionId);
    }, 5 * 60 * 1000).unref();

    if (nextState === 'completed') {
      this.emit('loop-complete', {
        sessionId: runtime.sessionId,
        totalIterations: runtime.currentIteration,
        finalScore: runtime.lastScore,
        reason,
      });
      return;
    }

    this.emit('loop-error', {
      sessionId: runtime.sessionId,
      error: reason,
      iteration: runtime.currentIteration,
      lastScore: runtime.lastScore,
    });
  }
}
