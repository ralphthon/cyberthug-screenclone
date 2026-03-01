import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  octokitConstructorMock,
  usersGetAuthenticatedMock,
  reposGetMock,
  getRefMock,
  createRefMock,
  getCommitMock,
  createTreeMock,
  createCommitMock,
  updateRefMock,
  readdirMock,
  readFileMock,
} = vi.hoisted(() => {
  const usersGetAuthenticatedMock = vi.fn();
  const reposGetMock = vi.fn();
  const getRefMock = vi.fn();
  const createRefMock = vi.fn();
  const getCommitMock = vi.fn();
  const createTreeMock = vi.fn();
  const createCommitMock = vi.fn();
  const updateRefMock = vi.fn();
  const readdirMock = vi.fn();
  const readFileMock = vi.fn();

  const octokitConstructorMock = vi.fn().mockImplementation(function MockOctokit() {
    return {
      rest: {
        users: { getAuthenticated: usersGetAuthenticatedMock },
        repos: { get: reposGetMock },
        git: {
          getRef: getRefMock,
          createRef: createRefMock,
          getCommit: getCommitMock,
          createTree: createTreeMock,
          createCommit: createCommitMock,
          updateRef: updateRefMock,
        },
      },
    };
  });

  return {
    octokitConstructorMock,
    usersGetAuthenticatedMock,
    reposGetMock,
    getRefMock,
    createRefMock,
    getCommitMock,
    createTreeMock,
    createCommitMock,
    updateRefMock,
    readdirMock,
    readFileMock,
  };
});

vi.mock('@octokit/rest', () => ({
  Octokit: octokitConstructorMock,
}));

vi.mock('node:fs', () => ({
  promises: {
    readdir: readdirMock,
    readFile: readFileMock,
  },
}));

const importModule = () => import('../../../src/server/githubCommitService.ts');

const createSession = (overrides: Record<string, unknown> = {}) => ({
  octokit: octokitConstructorMock(),
  owner: 'acme',
  repo: 'screenclone',
  branchName: 'ralph/clone-screenclone-20260301000000',
  branchRef: 'heads/ralph/clone-screenclone-20260301000000',
  defaultBranch: 'main',
  projectName: 'ScreenClone',
  sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  originalScreenshotReference: 'shot.png',
  branchCreated: false,
  committedIterations: new Set<number>(),
  ...overrides,
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  octokitConstructorMock.mockImplementation(function MockOctokit() {
    return {
      rest: {
        users: { getAuthenticated: usersGetAuthenticatedMock },
        repos: { get: reposGetMock },
        git: {
          getRef: getRefMock,
          createRef: createRefMock,
          getCommit: getCommitMock,
          createTree: createTreeMock,
          createCommit: createCommitMock,
          updateRef: updateRefMock,
        },
      },
    };
  });

  usersGetAuthenticatedMock.mockResolvedValue({ data: { login: 'tester' } });
  reposGetMock.mockResolvedValue({ data: { default_branch: 'main' } });
  readdirMock.mockResolvedValue([]);
  readFileMock.mockRejectedValue(new Error('ENOENT'));
});

describe('githubCommitService', () => {
  it('exposes GitHubCommitError fields', async () => {
    const { GitHubCommitError } = await importModule();
    const error = new GitHubCommitError('bad token', 'INVALID_TOKEN', 401);

    expect(error.message).toBe('bad token');
    expect(error.code).toBe('INVALID_TOKEN');
    expect(error.status).toBe(401);
  });

  it.each([
    'https://github.com/acme/screenclone',
    'https://www.github.com/acme/screenclone.git',
    'https://github.com/acme/screenclone/tree/main',
  ])('parses valid repo URL through initializeGitHubCommitSession: %s', async (repoUrl) => {
    const { initializeGitHubCommitSession } = await importModule();
    const session = await initializeGitHubCommitSession({
      projectName: 'My Project',
      sessionId: 'b1ffcd00-ad1c-4ef9-bc7e-7cc0ce491b22',
      repoUrl,
      token: 'token-1',
    });

    expect(session.owner).toBe('acme');
    expect(session.repo).toBe('screenclone');
    expect(session.defaultBranch).toBe('main');
    expect(session.branchRef).toBe(`heads/${session.branchName}`);
    expect(session.branchName).toMatch(/^ralph\/clone-my-project-\d{14}$/);
    expect(octokitConstructorMock).toHaveBeenCalledWith({ auth: 'token-1' });
    expect(reposGetMock).toHaveBeenCalledWith({ owner: 'acme', repo: 'screenclone' });
  });

  it.each(['not-a-url', 'https://github.com', 'https://github.com/acme'])(
    'rejects invalid or incomplete repo URL: %s',
    async (repoUrl) => {
      const { initializeGitHubCommitSession } = await importModule();

      await expect(
        initializeGitHubCommitSession({
          projectName: 'Invalid Repo',
          sessionId: 'c2aabb11-be2d-4ef0-ad8f-8dd1df592c33',
          repoUrl,
          token: 'token-2',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_REPO',
        status: 400,
      });
    },
  );

  it('rejects non-github hosts', async () => {
    const { initializeGitHubCommitSession } = await importModule();

    await expect(
      initializeGitHubCommitSession({
        projectName: 'Invalid Host',
        sessionId: 'd3bbcc22-cf3e-4fa1-be90-9ee2ef6a3d44',
        repoUrl: 'https://gitlab.com/acme/screenclone',
        token: 'token-3',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REPO',
      status: 400,
    });
  });

  it('initializes commit session successfully and captures screenshot reference', async () => {
    readdirMock.mockResolvedValue(['z.png', 'a.jpg', 'notes.txt']);

    const { initializeGitHubCommitSession } = await importModule();
    const session = await initializeGitHubCommitSession({
      projectName: 'Space Clone',
      sessionId: 'e4ccdd33-d04f-4fb2-af01-aff3f07b4e55',
      repoUrl: 'https://github.com/acme/screenclone',
      token: 'token-success',
    });

    expect(session.owner).toBe('acme');
    expect(session.repo).toBe('screenclone');
    expect(session.defaultBranch).toBe('main');
    expect(session.branchCreated).toBe(false);
    expect(session.originalScreenshotReference).toBe('a.jpg');
    expect(session.committedIterations.size).toBe(0);
  });

  it('maps authentication failures to INVALID_TOKEN', async () => {
    usersGetAuthenticatedMock.mockRejectedValue(new Error('unauthorized'));

    const { initializeGitHubCommitSession } = await importModule();

    await expect(
      initializeGitHubCommitSession({
        projectName: 'Auth Fail',
        sessionId: 'f5ddee44-e150-4ab3-b012-b004f18c5f66',
        repoUrl: 'https://github.com/acme/screenclone',
        token: 'bad-token',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
      status: 401,
    });
  });

  it('maps repository 404 to INVALID_REPO', async () => {
    reposGetMock.mockRejectedValue({ status: 404 });

    const { initializeGitHubCommitSession } = await importModule();

    await expect(
      initializeGitHubCommitSession({
        projectName: 'Repo Missing',
        sessionId: 'a6eeff55-f261-4bc4-a123-c115a29d6a77',
        repoUrl: 'https://github.com/acme/missing-repo',
        token: 'token-ok',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REPO',
      status: 400,
    });
  });

  it('commits improvement snapshot successfully', async () => {
    getRefMock
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ data: { object: { sha: 'base-sha' } } })
      .mockResolvedValueOnce({ data: { object: { sha: 'head-sha' } } });
    createRefMock.mockResolvedValue({ data: {} });
    getCommitMock.mockResolvedValue({ data: { tree: { sha: 'tree-head-sha' } } });
    createTreeMock.mockResolvedValue({ data: { sha: 'tree-new-sha' } });
    createCommitMock.mockResolvedValue({ data: { sha: 'commit-sha-1' } });
    updateRefMock.mockResolvedValue({ data: {} });

    const { commitImprovementSnapshot } = await importModule();
    const session = createSession();
    const commitUrl = await commitImprovementSnapshot({
      session: session as never,
      iteration: 2,
      score: 95,
      delta: 2,
      files: {
        indexHtml: '<html></html>',
        stylesCss: 'body {}',
        scriptJs: 'console.log("ok")',
        readme: '# readme',
      },
    });

    expect(commitUrl).toBe('https://github.com/acme/screenclone/commit/commit-sha-1');
    expect(createCommitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'screenclone',
        message: 'ralph(#2): score 95% (+2%)',
      }),
    );
    expect(updateRefMock).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'screenclone',
      ref: 'heads/ralph/clone-screenclone-20260301000000',
      sha: 'commit-sha-1',
      force: false,
    });
    expect(session.committedIterations.has(2)).toBe(true);
    expect(session.branchCreated).toBe(true);
  });

  it('skips duplicate improvement iteration commits', async () => {
    const { commitImprovementSnapshot } = await importModule();
    const session = createSession({ committedIterations: new Set<number>([3]) });
    const commitUrl = await commitImprovementSnapshot({
      session: session as never,
      iteration: 3,
      score: 96,
      delta: 1,
      files: {
        indexHtml: '<html></html>',
        stylesCss: 'body {}',
        scriptJs: 'console.log("ok")',
        readme: '# readme',
      },
    });

    expect(commitUrl).toBe('');
    expect(getRefMock).not.toHaveBeenCalled();
    expect(createTreeMock).not.toHaveBeenCalled();
    expect(createCommitMock).not.toHaveBeenCalled();
  });

  it('commits final snapshot successfully', async () => {
    getRefMock.mockResolvedValueOnce({ data: { object: { sha: 'head-final-sha' } } });
    getCommitMock.mockResolvedValueOnce({ data: { tree: { sha: 'head-tree-sha' } } });
    createTreeMock.mockResolvedValueOnce({ data: { sha: 'final-tree-sha' } });
    createCommitMock.mockResolvedValueOnce({ data: { sha: 'final-commit-sha' } });
    updateRefMock.mockResolvedValueOnce({ data: {} });

    const { commitFinalSnapshot } = await importModule();
    const session = createSession({ branchCreated: true });
    const commitUrl = await commitFinalSnapshot({
      session: session as never,
      iteration: 5,
      score: 99.5,
      files: {
        indexHtml: '<html></html>',
        stylesCss: 'body {}',
        scriptJs: 'console.log("ok")',
        readme: '# readme',
      },
    });

    expect(commitUrl).toBe('https://github.com/acme/screenclone/commit/final-commit-sha');
    expect(createCommitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'screenclone',
        message: '[final] ralph(#5): score 99.5%',
      }),
    );
    expect(updateRefMock).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'screenclone',
      ref: 'heads/ralph/clone-screenclone-20260301000000',
      sha: 'final-commit-sha',
      force: false,
    });
  });

  it('builds session readme with score history and screenshot reference', async () => {
    const { buildSessionReadme } = await importModule();
    const readme = buildSessionReadme({
      projectName: 'Neon App',
      branchName: 'ralph/clone-neon-app-20260301010101',
      targetScore: 97.5,
      originalScreenshotReference: 'source.png',
      scoreHistory: [
        {
          iteration: 1,
          score: 88.25,
          delta: null,
          commitUrl: null,
          recordedAt: '2026-03-01T00:00:00.000Z',
        },
        {
          iteration: 2,
          score: 91.5,
          delta: 3.25,
          commitUrl: 'https://github.com/acme/screenclone/commit/abc123',
          recordedAt: '2026-03-01T00:10:00.000Z',
        },
      ],
    });

    expect(readme).toContain('# Neon App Clone');
    expect(readme).toContain('- Original screenshot reference: `source.png`');
    expect(readme).toContain('| 1 | 88.25% | - | - | 2026-03-01T00:00:00.000Z |');
    expect(readme).toContain(
      '| 2 | 91.5% | 3.25% | [commit](https://github.com/acme/screenclone/commit/abc123) | 2026-03-01T00:10:00.000Z |',
    );
  });

  it('builds session readme with empty score history and unavailable screenshot reference', async () => {
    const { buildSessionReadme } = await importModule();
    const readme = buildSessionReadme({
      projectName: 'Empty Log',
      branchName: 'ralph/clone-empty-log-20260301020202',
      targetScore: 90,
      originalScreenshotReference: null,
      scoreHistory: [],
    });

    expect(readme).toContain('- Original screenshot reference: unavailable');
    expect(readme).toContain('| - | - | - | - | - |');
  });

  it('builds snapshot files from workspace outputs when available', async () => {
    readFileMock.mockImplementation(async (candidatePath: string) => {
      if (candidatePath.endsWith('/workspace/index.html')) {
        return '<html><body>ok</body></html>\n';
      }
      if (candidatePath.endsWith('/workspace/styles.css')) {
        return 'body { color: red; }\n';
      }
      if (candidatePath.endsWith('/workspace/script.js')) {
        return 'console.log("ok");\n';
      }
      throw new Error('ENOENT');
    });

    const { buildSnapshotFiles } = await importModule();
    const files = await buildSnapshotFiles({
      sessionId: 'b7ff0066-a372-4cd5-b234-d226b3ae7b88',
      projectName: 'Workspace Project',
      targetScore: 94,
      branchName: 'ralph/clone-workspace-project-20260301030303',
      originalScreenshotReference: 'orig.png',
      scoreHistory: [],
    });

    expect(files.indexHtml).toBe('<html><body>ok</body></html>\n');
    expect(files.stylesCss).toBe('body { color: red; }\n');
    expect(files.scriptJs).toBe('console.log("ok");\n');
    expect(files.readme).toContain('# Workspace Project Clone');
    expect(readFileMock).toHaveBeenCalledTimes(3);
  });

  it('builds snapshot files with fallback defaults when workspace files are missing', async () => {
    readFileMock.mockRejectedValue(new Error('missing'));

    const { buildSnapshotFiles } = await importModule();
    const files = await buildSnapshotFiles({
      sessionId: 'c8001177-b483-4de6-a345-e337c4bf8c99',
      projectName: 'Fallback Project',
      targetScore: 92,
      branchName: 'ralph/clone-fallback-project-20260301040404',
      originalScreenshotReference: null,
      scoreHistory: [],
    });

    expect(files.indexHtml).toBe('<!doctype html>\n<html><body><main>Generated clone unavailable.</main></body></html>\n');
    expect(files.stylesCss).toBe('/* Generated clone styles were not found for this iteration. */\n');
    expect(files.scriptJs).toBe('// Generated clone script was not found for this iteration.\n');
    expect(files.readme).toContain('# Fallback Project Clone');
    expect(readFileMock).toHaveBeenCalledTimes(9);
  });
});
