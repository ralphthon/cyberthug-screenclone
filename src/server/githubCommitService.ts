import { Octokit } from '@octokit/rest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const SESSION_DIR_PREFIX = 'ralphton-';
const TMP_ROOT = '/tmp';
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

const slugify = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'screenclone';
};

const formatTimestamp = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
};

const formatScore = (value: number): string => {
  return Number(value.toFixed(2)).toString();
};

const readFirstExistingFile = async (paths: string[]): Promise<string | null> => {
  for (const candidatePath of paths) {
    try {
      const file = await fs.readFile(candidatePath, 'utf8');
      if (file.trim().length > 0) {
        return file;
      }
    } catch {
      // Continue looking for a usable candidate.
    }
  }

  return null;
};

const getErrorStatus = (error: unknown): number | null => {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const maybeStatus = (error as { status?: unknown }).status;
  return typeof maybeStatus === 'number' ? maybeStatus : null;
};

const parseRepoUrl = (repoUrl: string): { owner: string; repo: string } => {
  let parsed: URL;

  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new GitHubCommitError('GitHub repo URL is invalid', 'INVALID_REPO', 400);
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    throw new GitHubCommitError('GitHub repo URL must point to github.com', 'INVALID_REPO', 400);
  }

  const segments = parsed.pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length < 2) {
    throw new GitHubCommitError('GitHub repo URL must include owner and repo name', 'INVALID_REPO', 400);
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');

  if (!owner || !repo) {
    throw new GitHubCommitError('GitHub repo URL must include owner and repo name', 'INVALID_REPO', 400);
  }

  return { owner, repo };
};

export type ScoreHistoryEntry = {
  iteration: number;
  score: number;
  delta: number | null;
  commitUrl: string | null;
  recordedAt: string;
};

export type GitHubCommitSession = {
  octokit: Octokit;
  owner: string;
  repo: string;
  branchName: string;
  branchRef: string;
  defaultBranch: string;
  projectName: string;
  sessionId: string;
  originalScreenshotReference: string | null;
  branchCreated: boolean;
  committedIterations: Set<number>;
};

export type GitHubSnapshotFiles = {
  indexHtml: string;
  stylesCss: string;
  scriptJs: string;
  readme: string;
};

export type IterationCommitInput = {
  session: GitHubCommitSession;
  iteration: number;
  score: number;
  delta: number;
  files: GitHubSnapshotFiles;
};

export type FinalCommitInput = {
  session: GitHubCommitSession;
  iteration: number;
  score: number;
  files: GitHubSnapshotFiles;
};

export class GitHubCommitError extends Error {
  public readonly code: 'INVALID_TOKEN' | 'INVALID_REPO' | 'API_FAILURE';
  public readonly status: number;

  constructor(message: string, code: 'INVALID_TOKEN' | 'INVALID_REPO' | 'API_FAILURE', status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const initializeGitHubCommitSession = async (params: {
  projectName: string;
  sessionId: string;
  repoUrl: string;
  token: string;
}): Promise<GitHubCommitSession> => {
  const { owner, repo } = parseRepoUrl(params.repoUrl);
  const octokit = new Octokit({ auth: params.token });

  try {
    await octokit.rest.users.getAuthenticated();
  } catch {
    throw new GitHubCommitError('GitHub token is invalid', 'INVALID_TOKEN', 401);
  }

  let defaultBranch: string;
  try {
    const repoResponse = await octokit.rest.repos.get({ owner, repo });
    defaultBranch = repoResponse.data.default_branch;
  } catch (error) {
    const status = getErrorStatus(error);
    if (status === 404) {
      throw new GitHubCommitError('GitHub repository not found', 'INVALID_REPO', 400);
    }

    throw new GitHubCommitError('Failed to access GitHub repository metadata', 'API_FAILURE', status ?? 502);
  }

  const branchName = `ralph/clone-${slugify(params.projectName)}-${formatTimestamp(new Date())}`;

  let originalScreenshotReference: string | null = null;
  const sessionDir = path.join(TMP_ROOT, `${SESSION_DIR_PREFIX}${params.sessionId}`);
  try {
    const entries = await fs.readdir(sessionDir);
    const firstImage = entries
      .filter((entry) => IMAGE_EXTENSIONS.has(path.extname(entry).toLowerCase()))
      .sort((a, b) => a.localeCompare(b))[0];

    if (firstImage) {
      originalScreenshotReference = firstImage;
    }
  } catch {
    // Missing local image reference should not block commits.
  }

  return {
    octokit,
    owner,
    repo,
    branchName,
    branchRef: `heads/${branchName}`,
    defaultBranch,
    projectName: params.projectName,
    sessionId: params.sessionId,
    originalScreenshotReference,
    branchCreated: false,
    committedIterations: new Set<number>(),
  };
};

const ensureBranchExists = async (session: GitHubCommitSession): Promise<void> => {
  if (session.branchCreated) {
    return;
  }

  try {
    await session.octokit.rest.git.getRef({
      owner: session.owner,
      repo: session.repo,
      ref: session.branchRef,
    });
    session.branchCreated = true;
    return;
  } catch (error) {
    const status = getErrorStatus(error);
    if (status !== 404) {
      throw new GitHubCommitError('Failed to inspect target branch', 'API_FAILURE', status ?? 502);
    }
  }

  let baseSha: string;
  try {
    const baseRef = await session.octokit.rest.git.getRef({
      owner: session.owner,
      repo: session.repo,
      ref: `heads/${session.defaultBranch}`,
    });
    baseSha = baseRef.data.object.sha;
  } catch (error) {
    const status = getErrorStatus(error);
    throw new GitHubCommitError('Failed to resolve default branch ref', 'API_FAILURE', status ?? 502);
  }

  try {
    await session.octokit.rest.git.createRef({
      owner: session.owner,
      repo: session.repo,
      ref: `refs/${session.branchRef}`,
      sha: baseSha,
    });
    session.branchCreated = true;
  } catch (error) {
    const status = getErrorStatus(error);
    if (status === 422) {
      session.branchCreated = true;
      return;
    }

    throw new GitHubCommitError('Failed to create target branch', 'API_FAILURE', status ?? 502);
  }
};

const getBranchHead = async (session: GitHubCommitSession): Promise<{ commitSha: string; treeSha: string }> => {
  let commitSha: string;
  try {
    const refResponse = await session.octokit.rest.git.getRef({
      owner: session.owner,
      repo: session.repo,
      ref: session.branchRef,
    });
    commitSha = refResponse.data.object.sha;
  } catch (error) {
    const status = getErrorStatus(error);
    throw new GitHubCommitError('Failed to read branch head', 'API_FAILURE', status ?? 502);
  }

  try {
    const commitResponse = await session.octokit.rest.git.getCommit({
      owner: session.owner,
      repo: session.repo,
      commit_sha: commitSha,
    });

    return {
      commitSha,
      treeSha: commitResponse.data.tree.sha,
    };
  } catch (error) {
    const status = getErrorStatus(error);
    throw new GitHubCommitError('Failed to read commit tree', 'API_FAILURE', status ?? 502);
  }
};

const commitSnapshot = async (
  session: GitHubCommitSession,
  message: string,
  files: GitHubSnapshotFiles,
): Promise<string> => {
  await ensureBranchExists(session);

  const head = await getBranchHead(session);

  let treeSha: string;
  try {
    const treeResponse = await session.octokit.rest.git.createTree({
      owner: session.owner,
      repo: session.repo,
      base_tree: head.treeSha,
      tree: [
        { path: 'index.html', mode: '100644', type: 'blob', content: files.indexHtml },
        { path: 'styles.css', mode: '100644', type: 'blob', content: files.stylesCss },
        { path: 'script.js', mode: '100644', type: 'blob', content: files.scriptJs },
        { path: 'README.md', mode: '100644', type: 'blob', content: files.readme },
      ],
    });

    treeSha = treeResponse.data.sha;
  } catch (error) {
    const status = getErrorStatus(error);
    throw new GitHubCommitError('Failed to create commit tree', 'API_FAILURE', status ?? 502);
  }

  let commitSha: string;
  try {
    const commitResponse = await session.octokit.rest.git.createCommit({
      owner: session.owner,
      repo: session.repo,
      message,
      tree: treeSha,
      parents: [head.commitSha],
    });

    commitSha = commitResponse.data.sha;
  } catch (error) {
    const status = getErrorStatus(error);
    throw new GitHubCommitError('Failed to create commit', 'API_FAILURE', status ?? 502);
  }

  try {
    await session.octokit.rest.git.updateRef({
      owner: session.owner,
      repo: session.repo,
      ref: session.branchRef,
      sha: commitSha,
      force: false,
    });
  } catch (error) {
    const status = getErrorStatus(error);
    throw new GitHubCommitError('Failed to update branch ref', 'API_FAILURE', status ?? 502);
  }

  return `https://github.com/${session.owner}/${session.repo}/commit/${commitSha}`;
};

export const commitImprovementSnapshot = async (input: IterationCommitInput): Promise<string> => {
  const { session, iteration, score, delta, files } = input;

  if (session.committedIterations.has(iteration)) {
    return '';
  }

  const message = `ralph(#${iteration}): score ${formatScore(score)}% (+${formatScore(delta)}%)`;
  const commitUrl = await commitSnapshot(session, message, files);
  session.committedIterations.add(iteration);
  return commitUrl;
};

export const commitFinalSnapshot = async (input: FinalCommitInput): Promise<string> => {
  const { session, iteration, score, files } = input;
  const message = `[final] ralph(#${iteration}): score ${formatScore(score)}%`;
  return commitSnapshot(session, message, files);
};

export const buildSessionReadme = (params: {
  projectName: string;
  branchName: string;
  targetScore: number;
  originalScreenshotReference: string | null;
  scoreHistory: ScoreHistoryEntry[];
}): string => {
  const lines: string[] = [
    `# ${params.projectName} Clone`,
    '',
    'Generated by RalphTon ScreenClone auto-commit workflow.',
    '',
    `- Branch: \`${params.branchName}\``,
    `- Target similarity: ${params.targetScore}%`,
  ];

  if (params.originalScreenshotReference) {
    lines.push(`- Original screenshot reference: \`${params.originalScreenshotReference}\``);
  } else {
    lines.push('- Original screenshot reference: unavailable');
  }

  lines.push('', '## Iteration Log', '', '| Iteration | Score | Delta | Commit | Timestamp |', '| --- | ---: | ---: | --- | --- |');

  if (params.scoreHistory.length === 0) {
    lines.push('| - | - | - | - | - |');
  } else {
    for (const entry of params.scoreHistory) {
      const deltaText = entry.delta === null ? '-' : `${formatScore(entry.delta)}%`;
      const commitText = entry.commitUrl ? `[commit](${entry.commitUrl})` : '-';
      lines.push(
        `| ${entry.iteration} | ${formatScore(entry.score)}% | ${deltaText} | ${commitText} | ${entry.recordedAt} |`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
};

export const buildSnapshotFiles = async (params: {
  sessionId: string;
  projectName: string;
  targetScore: number;
  branchName: string;
  originalScreenshotReference: string | null;
  scoreHistory: ScoreHistoryEntry[];
}): Promise<GitHubSnapshotFiles> => {
  const workspaceDir = path.join(TMP_ROOT, `${SESSION_DIR_PREFIX}${params.sessionId}`, 'workspace');
  const indexHtml =
    (await readFirstExistingFile([
      path.join(workspaceDir, 'index.html'),
      path.join(workspaceDir, 'generated', 'index.html'),
      path.join(workspaceDir, 'output', 'index.html'),
    ])) ?? '<!doctype html>\n<html><body><main>Generated clone unavailable.</main></body></html>\n';

  const stylesCss =
    (await readFirstExistingFile([
      path.join(workspaceDir, 'styles.css'),
      path.join(workspaceDir, 'generated', 'styles.css'),
      path.join(workspaceDir, 'output', 'styles.css'),
    ])) ?? '/* Generated clone styles were not found for this iteration. */\n';

  const scriptJs =
    (await readFirstExistingFile([
      path.join(workspaceDir, 'script.js'),
      path.join(workspaceDir, 'generated', 'script.js'),
      path.join(workspaceDir, 'output', 'script.js'),
    ])) ?? '// Generated clone script was not found for this iteration.\n';

  const readme = buildSessionReadme({
    projectName: params.projectName,
    branchName: params.branchName,
    targetScore: params.targetScore,
    originalScreenshotReference: params.originalScreenshotReference,
    scoreHistory: params.scoreHistory,
  });

  return {
    indexHtml,
    stylesCss,
    scriptJs,
    readme,
  };
};
