import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const MAX_FILES = 5;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_FILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const CONFIG_STORAGE_KEY = 'ralphton-config';

type Toast = {
  id: number;
  message: string;
};

type PreviewItem = {
  file: File;
  url: string;
};

type CloneConfig = {
  projectName: string;
  githubRepoUrl: string;
  githubToken: string;
  maxIterations: string;
  targetSimilarity: string;
};

type CloneConfigField = keyof CloneConfig;

type CloneConfigErrors = Partial<Record<CloneConfigField, string>>;

const DEFAULT_CLONE_CONFIG: CloneConfig = {
  projectName: '',
  githubRepoUrl: '',
  githubToken: '',
  maxIterations: '1000',
  targetSimilarity: '90',
};

function coerceStoredConfig(value: unknown): CloneConfig | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<Record<CloneConfigField, unknown>>;

  const toStringValue = (field: CloneConfigField): string => {
    const fieldValue = candidate[field];
    return typeof fieldValue === 'string' ? fieldValue : DEFAULT_CLONE_CONFIG[field];
  };

  return {
    projectName: toStringValue('projectName'),
    githubRepoUrl: toStringValue('githubRepoUrl'),
    githubToken: toStringValue('githubToken'),
    maxIterations: toStringValue('maxIterations'),
    targetSimilarity: toStringValue('targetSimilarity'),
  };
}

function App(): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimersRef = useRef<number[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [cloneConfig, setCloneConfig] = useState<CloneConfig>(DEFAULT_CLONE_CONFIG);
  const [cloneConfigErrors, setCloneConfigErrors] = useState<CloneConfigErrors>({});
  const [showGithubToken, setShowGithubToken] = useState(false);
  const [isCloneRunning, setIsCloneRunning] = useState(false);

  const previews = useMemo<PreviewItem[]>(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );

  useEffect(() => {
    return () => {
      for (const preview of previews) {
        URL.revokeObjectURL(preview.url);
      }
    };
  }, [previews]);

  useEffect(() => {
    return () => {
      for (const timerId of toastTimersRef.current) {
        window.clearTimeout(timerId);
      }
    };
  }, []);

  useEffect(() => {
    const savedConfig = window.localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!savedConfig) {
      return;
    }

    try {
      const parsed = JSON.parse(savedConfig) as unknown;
      const nextConfig = coerceStoredConfig(parsed);

      if (nextConfig) {
        setCloneConfig(nextConfig);
      }
    } catch {
      window.localStorage.removeItem(CONFIG_STORAGE_KEY);
    }
  }, []);

  const addToast = useCallback((message: string) => {
    const toastId = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((previous) => [...previous, { id: toastId, message }]);

    const timerId = window.setTimeout(() => {
      setToasts((previous) => previous.filter((toast) => toast.id !== toastId));
      toastTimersRef.current = toastTimersRef.current.filter((activeId) => activeId !== timerId);
    }, 3200);

    toastTimersRef.current.push(timerId);
  }, []);

  const handleIncomingFiles = useCallback(
    (incomingFiles: File[]) => {
      if (incomingFiles.length === 0) {
        return;
      }

      let remainingSlots = MAX_FILES - files.length;
      if (remainingSlots <= 0) {
        addToast('Maximum reached. Remove an image before adding more.');
        return;
      }

      const acceptedFiles: File[] = [];
      let typeRejections = 0;
      let sizeRejections = 0;
      let overflowRejections = 0;

      for (const file of incomingFiles) {
        if (!ACCEPTED_FILE_TYPES.has(file.type)) {
          typeRejections += 1;
          continue;
        }

        if (file.size > MAX_FILE_SIZE_BYTES) {
          sizeRejections += 1;
          continue;
        }

        if (remainingSlots === 0) {
          overflowRejections += 1;
          continue;
        }

        acceptedFiles.push(file);
        remainingSlots -= 1;
      }

      if (typeRejections > 0) {
        addToast('Only PNG, JPG, and WEBP images are allowed.');
      }

      if (sizeRejections > 0) {
        addToast('Each file must be 10MB or less.');
      }

      if (overflowRejections > 0) {
        addToast('Only 5 screenshots can be uploaded at once.');
      }

      if (acceptedFiles.length > 0) {
        setFiles((previous) => [...previous, ...acceptedFiles]);
      }
    },
    [addToast, files.length],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      if (files.length < MAX_FILES) {
        setIsDragActive(true);
      }
    },
    [files.length],
  );

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }

    setIsDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDragActive(false);

      if (files.length >= MAX_FILES) {
        addToast('Maximum reached. Remove an image before adding more.');
        return;
      }

      handleIncomingFiles(Array.from(event.dataTransfer.files));
    },
    [addToast, files.length, handleIncomingFiles],
  );

  const handleBrowseFiles = useCallback(() => {
    if (files.length >= MAX_FILES) {
      addToast('Maximum reached. Remove an image before adding more.');
      return;
    }

    fileInputRef.current?.click();
  }, [addToast, files.length]);

  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      handleIncomingFiles(Array.from(event.target.files ?? []));
      event.currentTarget.value = '';
    },
    [handleIncomingFiles],
  );

  const handleDropZoneKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      event.preventDefault();
      handleBrowseFiles();
    },
    [handleBrowseFiles],
  );

  const removeFile = useCallback((index: number) => {
    setFiles((previous) => previous.filter((_, fileIndex) => fileIndex !== index));
  }, []);

  const validateCloneConfig = useCallback((config: CloneConfig): CloneConfigErrors => {
    const nextErrors: CloneConfigErrors = {};

    if (config.projectName.trim().length === 0) {
      nextErrors.projectName = 'Project name is required.';
    }

    const trimmedRepoUrl = config.githubRepoUrl.trim();
    if (trimmedRepoUrl.length > 0) {
      try {
        const parsedUrl = new URL(trimmedRepoUrl);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          nextErrors.githubRepoUrl = 'GitHub repo URL must start with http:// or https://.';
        }
      } catch {
        nextErrors.githubRepoUrl = 'Enter a valid GitHub repo URL.';
      }
    }

    const maxIterations = Number(config.maxIterations);
    if (!Number.isInteger(maxIterations) || maxIterations < 1) {
      nextErrors.maxIterations = 'Max iterations must be an integer of at least 1.';
    }

    const targetSimilarity = Number(config.targetSimilarity);
    if (!Number.isFinite(targetSimilarity) || targetSimilarity < 50 || targetSimilarity > 100) {
      nextErrors.targetSimilarity = 'Target similarity must be between 50 and 100.';
    }

    return nextErrors;
  }, []);

  const handleConfigValueChange = useCallback(
    (field: CloneConfigField, value: string) => {
      setCloneConfig((previous) => ({ ...previous, [field]: value }));
      setCloneConfigErrors((previous) => ({ ...previous, [field]: undefined }));
    },
    [],
  );

  const handleStartClone = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (isCloneRunning) {
        return;
      }

      const nextErrors = validateCloneConfig(cloneConfig);
      const hasErrors = Object.values(nextErrors).some((error) => typeof error === 'string');

      if (hasErrors) {
        setCloneConfigErrors(nextErrors);
        return;
      }

      if (files.length === 0) {
        addToast('Upload at least one screenshot before starting.');
        return;
      }

      window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cloneConfig));
      setCloneConfigErrors({});
      setIsCloneRunning(true);
      addToast('Clone session started.');
    },
    [addToast, cloneConfig, files.length, isCloneRunning, validateCloneConfig],
  );

  const canStartClone = cloneConfig.projectName.trim().length > 0 && files.length > 0 && !isCloneRunning;

  const uploadFormData = useMemo(() => {
    const formData = new FormData();

    for (const file of files) {
      formData.append('screenshots', file);
    }

    return formData;
  }, [files]);

  const uploadCount = uploadFormData.getAll('screenshots').length;
  const dropZoneDisabled = files.length >= MAX_FILES;

  return (
    <main className="min-h-screen bg-surface text-slate-100">
      <div className="pointer-events-none fixed right-5 top-5 z-20 flex w-full max-w-sm flex-col gap-3">
        {toasts.map((toast) => (
          <p
            key={toast.id}
            className="rounded-lg border border-red-400/50 bg-card/95 px-4 py-2 text-sm text-red-200 shadow-lg"
          >
            {toast.message}
          </p>
        ))}
      </div>

      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-8">
        <header className="mb-10 flex items-center gap-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-indigo-400 to-indigo-600 text-xs font-bold text-white">
            SC
          </span>
          <h1 className="text-3xl font-bold tracking-tight text-slate-100">ScreenClone</h1>
        </header>

        <section className="mx-auto w-full max-w-2xl">
          <div
            className={`rounded-2xl border-2 border-dashed px-8 py-10 text-center transition ${
              dropZoneDisabled
                ? 'cursor-not-allowed border-slate-700 bg-card/40 opacity-70'
                : isDragActive
                  ? 'cursor-copy border-primary bg-card/80 shadow-[0_0_0_1px_rgba(99,102,241,0.6)]'
                  : 'cursor-pointer border-indigo-500/40 bg-card/50 hover:border-indigo-400/80 hover:bg-card/70'
            }`}
            onClick={dropZoneDisabled ? undefined : handleBrowseFiles}
            onDragEnter={handleDragOver}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onKeyDown={dropZoneDisabled ? undefined : handleDropZoneKeyDown}
            role="button"
            tabIndex={dropZoneDisabled ? -1 : 0}
            aria-disabled={dropZoneDisabled}
          >
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full border border-indigo-400/60 text-xl text-indigo-300">
              +
            </div>
            <p className="text-3xl font-semibold text-slate-100">Drop screenshots here</p>
            <p className="mt-2 text-sm text-slate-400">PNG, JPG, WEBP - Max {MAX_FILES} images</p>
            <button
              type="button"
              className="mt-5 rounded-md bg-primary px-5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
            >
              Browse Files
            </button>
          </div>

          <div className="mt-3 flex items-center justify-between text-sm text-slate-400">
            <p>
              {files.length}/{MAX_FILES} uploaded
            </p>
            <p>{uploadCount > 0 ? `FormData ready: ${uploadCount} file(s)` : 'No files staged yet'}</p>
          </div>

          <div className="mt-6 grid grid-cols-5 gap-3">
            {Array.from({ length: MAX_FILES }, (_, slotIndex) => {
              const preview = previews[slotIndex];

              if (!preview) {
                return (
                  <div
                    key={`placeholder-${slotIndex}`}
                    className="aspect-[4/3] rounded-lg border border-dashed border-slate-700 bg-card/40"
                  />
                );
              }

              return (
                <div key={preview.url} className="relative aspect-[4/3] overflow-hidden rounded-lg border border-slate-700">
                  <img
                    src={preview.url}
                    alt={preview.file.name}
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                  <button
                    type="button"
                    onClick={() => removeFile(slotIndex)}
                    className="absolute right-1 top-1 rounded-full bg-black/65 px-1.5 py-0.5 text-xs font-semibold text-white transition hover:bg-black/85"
                    aria-label={`Remove ${preview.file.name}`}
                  >
                    X
                  </button>
                </div>
              );
            })}
          </div>

          <section className="mt-8 rounded-2xl border border-slate-700 bg-card/70 p-5 shadow-lg shadow-black/20">
            <h2 className="text-3xl font-semibold text-slate-100">Clone Settings</h2>
            <form className="mt-4 space-y-4" onSubmit={handleStartClone}>
              <fieldset disabled={isCloneRunning} className={isCloneRunning ? 'opacity-60' : ''}>
                <div className="space-y-4">
                  <label className="block">
                    <span className="block text-sm font-medium text-slate-200">Project Name *</span>
                    <input
                      type="text"
                      value={cloneConfig.projectName}
                      onChange={(event) => handleConfigValueChange('projectName', event.target.value)}
                      placeholder="my-landing-page"
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-surface/90 px-3 py-2 text-base text-slate-100 outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                    />
                    {cloneConfigErrors.projectName ? (
                      <span className="mt-1 block text-sm text-red-400">{cloneConfigErrors.projectName}</span>
                    ) : null}
                  </label>

                  <label className="block">
                    <span className="block text-sm font-medium text-slate-200">GitHub Repo URL</span>
                    <input
                      type="text"
                      value={cloneConfig.githubRepoUrl}
                      onChange={(event) => handleConfigValueChange('githubRepoUrl', event.target.value)}
                      placeholder="https://github.com/owner/repo"
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-surface/90 px-3 py-2 text-base text-slate-100 outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                    />
                    {cloneConfigErrors.githubRepoUrl ? (
                      <span className="mt-1 block text-sm text-red-400">{cloneConfigErrors.githubRepoUrl}</span>
                    ) : null}
                  </label>

                  <label className="block">
                    <span className="block text-sm font-medium text-slate-200">GitHub Token</span>
                    <div className="mt-1 flex items-center gap-2 rounded-lg border border-slate-700 bg-surface/90 px-3 py-2 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
                      <input
                        type={showGithubToken ? 'text' : 'password'}
                        value={cloneConfig.githubToken}
                        onChange={(event) => handleConfigValueChange('githubToken', event.target.value)}
                        placeholder="ghp_xxx..."
                        className="w-full bg-transparent text-base text-slate-100 outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowGithubToken((previous) => !previous)}
                        className="rounded-md px-2 py-1 text-sm text-indigo-300 transition hover:bg-primary/20 hover:text-indigo-200"
                        aria-label={showGithubToken ? 'Hide GitHub token' : 'Show GitHub token'}
                      >
                        {showGithubToken ? '🙈' : '👁️'}
                      </button>
                    </div>
                  </label>

                  <label className="block">
                    <span className="block text-sm font-medium text-slate-200">Max Iterations</span>
                    <input
                      type="number"
                      min={1}
                      value={cloneConfig.maxIterations}
                      onChange={(event) => handleConfigValueChange('maxIterations', event.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-surface/90 px-3 py-2 text-base text-slate-100 outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                    />
                    {cloneConfigErrors.maxIterations ? (
                      <span className="mt-1 block text-sm text-red-400">{cloneConfigErrors.maxIterations}</span>
                    ) : null}
                  </label>

                  <label className="block">
                    <span className="block text-sm font-medium text-slate-200">Target Similarity</span>
                    <input
                      type="number"
                      min={50}
                      max={100}
                      value={cloneConfig.targetSimilarity}
                      onChange={(event) => handleConfigValueChange('targetSimilarity', event.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-surface/90 px-3 py-2 text-base text-slate-100 outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                    />
                    {cloneConfigErrors.targetSimilarity ? (
                      <span className="mt-1 block text-sm text-red-400">
                        {cloneConfigErrors.targetSimilarity}
                      </span>
                    ) : null}
                  </label>
                </div>
              </fieldset>

              <button
                type="submit"
                disabled={!canStartClone}
                className="w-full rounded-lg bg-primary px-5 py-2.5 text-lg font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-600/70 disabled:text-slate-300"
              >
                🚀 Start Cloning
              </button>

              {isCloneRunning ? (
                <p className="text-center text-sm text-emerald-300">
                  Clone is running. Form is locked until the current session completes.
                </p>
              ) : null}
            </form>
          </section>
        </section>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={handleInputChange}
      />
    </main>
  );
}

export default App;
