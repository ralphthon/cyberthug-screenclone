import { useEffect, useMemo, useRef, useState } from 'react';

type Toast = {
  id: number;
  message: string;
};

type CloneConfig = {
  projectName: string;
  githubRepoUrl: string;
  githubToken: string;
  maxIterations: string;
  targetSimilarity: string;
};

type FormErrors = Partial<Record<keyof CloneConfig, string>>;

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const ACCEPTED_TYPE_SET = new Set<string>(ACCEPTED_TYPES);
const MAX_FILES = 5;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const CONFIG_STORAGE_KEY = 'ralphton-config';

const DEFAULT_CONFIG: CloneConfig = {
  projectName: '',
  githubRepoUrl: '',
  githubToken: '',
  maxIterations: '1000',
  targetSimilarity: '90',
};

function App(): JSX.Element {
  const [files, setFiles] = useState<File[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [config, setConfig] = useState<CloneConfig>(DEFAULT_CONFIG);
  const [errors, setErrors] = useState<FormErrors>({});
  const [showToken, setShowToken] = useState(false);
  const [isCloneRunning, setIsCloneRunning] = useState(false);
  const nextToastIdRef = useRef(1);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );

  const uploadPayload = useMemo(() => {
    const formData = new FormData();

    files.forEach((file) => {
      formData.append('screenshots', file);
    });

    return formData;
  }, [files]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY);

      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as Partial<CloneConfig>;

      setConfig({
        projectName:
          typeof parsed.projectName === 'string' ? parsed.projectName : DEFAULT_CONFIG.projectName,
        githubRepoUrl:
          typeof parsed.githubRepoUrl === 'string'
            ? parsed.githubRepoUrl
            : DEFAULT_CONFIG.githubRepoUrl,
        githubToken:
          typeof parsed.githubToken === 'string' ? parsed.githubToken : DEFAULT_CONFIG.githubToken,
        maxIterations:
          typeof parsed.maxIterations === 'string'
            ? parsed.maxIterations
            : DEFAULT_CONFIG.maxIterations,
        targetSimilarity:
          typeof parsed.targetSimilarity === 'string'
            ? parsed.targetSimilarity
            : DEFAULT_CONFIG.targetSimilarity,
      });
    } catch {
      showToast('Saved clone settings were invalid and could not be loaded.');
    }
  }, []);

  useEffect(() => {
    return () => {
      previews.forEach((preview) => URL.revokeObjectURL(preview.url));
    };
  }, [previews]);

  const isAtMaxFiles = files.length >= MAX_FILES;
  const remainingSlots = Math.max(MAX_FILES - previews.length, 0);
  const canStart = config.projectName.trim().length > 0 && files.length > 0;

  const showToast = (message: string): void => {
    const id = nextToastIdRef.current;
    nextToastIdRef.current += 1;

    setToasts((current) => [...current, { id, message }]);

    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3500);
  };

  const validateImageFile = (file: File): boolean => {
    if (!ACCEPTED_TYPE_SET.has(file.type)) {
      showToast(`Unsupported file type: ${file.name}. Only PNG, JPG, WEBP are allowed.`);
      return false;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      showToast(`File too large: ${file.name}. Maximum size is 10MB per image.`);
      return false;
    }

    return true;
  };

  const addFiles = (incoming: File[]): void => {
    if (incoming.length === 0) {
      return;
    }

    const validFiles = incoming.filter(validateImageFile);

    if (validFiles.length === 0) {
      return;
    }

    setFiles((currentFiles) => {
      if (currentFiles.length >= MAX_FILES) {
        showToast('Upload limit reached. Remove an image before adding more.');
        return currentFiles;
      }

      const slotsLeft = MAX_FILES - currentFiles.length;
      const filesToAdd = validFiles.slice(0, slotsLeft);

      if (validFiles.length > slotsLeft) {
        showToast(`Only ${MAX_FILES} images are allowed. Extra files were skipped.`);
      }

      return [...currentFiles, ...filesToAdd];
    });
  };

  const validateForm = (input: CloneConfig): FormErrors => {
    const nextErrors: FormErrors = {};

    if (input.projectName.trim().length === 0) {
      nextErrors.projectName = 'Project name is required.';
    }

    const parsedMaxIterations = Number(input.maxIterations);

    if (!Number.isFinite(parsedMaxIterations) || parsedMaxIterations < 1) {
      nextErrors.maxIterations = 'Max iterations must be at least 1.';
    }

    const parsedTargetSimilarity = Number(input.targetSimilarity);

    if (
      !Number.isFinite(parsedTargetSimilarity) ||
      parsedTargetSimilarity < 50 ||
      parsedTargetSimilarity > 100
    ) {
      nextErrors.targetSimilarity = 'Target similarity must be between 50 and 100.';
    }

    if (input.githubRepoUrl.trim().length > 0) {
      try {
        const parsedUrl = new URL(input.githubRepoUrl);

        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          nextErrors.githubRepoUrl = 'GitHub repo URL must start with http:// or https://.';
        }
      } catch {
        nextErrors.githubRepoUrl = 'GitHub repo URL must be a valid URL.';
      }
    }

    return nextErrors;
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(false);

    if (isAtMaxFiles) {
      showToast('Upload limit reached. Remove an image before adding more.');
      return;
    }

    const droppedFiles = Array.from(event.dataTransfer.files);
    addFiles(droppedFiles);
  };

  const handleBrowseClick = (): void => {
    if (isAtMaxFiles) {
      showToast('Upload limit reached. Remove an image before adding more.');
      return;
    }

    fileInputRef.current?.click();
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const selectedFiles = Array.from(event.target.files ?? []);
    addFiles(selectedFiles);
    event.currentTarget.value = '';
  };

  const handleRemoveImage = (indexToRemove: number): void => {
    setFiles((currentFiles) =>
      currentFiles.filter((_, fileIndex) => fileIndex !== indexToRemove),
    );
  };

  const handleConfigChange =
    (key: keyof CloneConfig) =>
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const nextValue = event.target.value;

      setConfig((current) => ({ ...current, [key]: nextValue }));
      setErrors((current) => ({ ...current, [key]: undefined }));
    };

  const handleCloneSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const validationErrors = validateForm(config);

    if (!canStart) {
      if (config.projectName.trim().length === 0) {
        validationErrors.projectName = 'Project name is required to start cloning.';
      }

      if (files.length === 0) {
        showToast('Upload at least one screenshot before starting the clone.');
      }
    }

    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0 || !canStart) {
      return;
    }

    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    setIsCloneRunning(true);
    showToast('Clone session started.');
  };

  return (
    <main className="min-h-screen bg-surface text-slate-100">
      <header className="border-b border-white/5">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-6 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/90 text-xs font-bold text-white">
            SC
          </div>
          <p className="text-xl font-semibold tracking-tight text-slate-100">ScreenClone</p>
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-16">
        <div className="text-center">
          <h1 className="bg-gradient-to-r from-primary via-indigo-400 to-violet-300 bg-clip-text text-5xl font-bold tracking-tight text-transparent">
            RalphTon
          </h1>
          <p className="mt-3 text-base text-slate-400">Drop screenshots and prepare your clone session.</p>
        </div>

        <article
          className={[
            'relative rounded-2xl border-2 border-dashed p-12 text-center transition-colors',
            isDragActive
              ? 'border-primary bg-primary/10'
              : 'border-primary/40 bg-card/60 hover:border-primary/70',
            isAtMaxFiles ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
          ].join(' ')}
          onClick={handleBrowseClick}
          onDragEnter={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!isAtMaxFiles) {
              setIsDragActive(true);
            }
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            event.stopPropagation();

            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setIsDragActive(false);
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onDrop={handleDrop}
          role="button"
          tabIndex={0}
          aria-label="Drop screenshots here"
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handleBrowseClick();
            }
          }}
        >
          <p className="absolute right-4 top-4 rounded-full bg-card px-3 py-1 text-xs font-semibold text-slate-300">
            {files.length}/{MAX_FILES}
          </p>
          <p className="text-4xl">[ ]</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-slate-100">
            Drop screenshots here
          </h2>
          <p className="mt-2 text-sm text-slate-400">PNG, JPG, WEBP - Max 10MB each</p>
          <button
            type="button"
            className="mt-6 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={(event) => {
              event.stopPropagation();
              handleBrowseClick();
            }}
            disabled={isAtMaxFiles}
          >
            Browse Files
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            onChange={handleInputChange}
            disabled={isAtMaxFiles}
          />
        </article>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-medium text-slate-300">Preview Thumbnails</p>
            <p className="text-sm text-slate-400">
              Ready in payload: {uploadPayload.getAll('screenshots').length}
            </p>
          </div>
          <div className="grid grid-cols-5 gap-3">
            {previews.map((preview, index) => (
              <div
                key={preview.url}
                className="relative overflow-hidden rounded-xl border border-white/10 bg-card/80"
              >
                <img
                  src={preview.url}
                  alt={`Screenshot preview ${index + 1}`}
                  className="aspect-video h-full w-full object-contain"
                />
                <button
                  type="button"
                  className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/65 text-base leading-none text-white transition-colors hover:bg-black/85"
                  onClick={() => handleRemoveImage(index)}
                  aria-label={`Remove screenshot ${index + 1}`}
                >
                  x
                </button>
              </div>
            ))}
            {Array.from({ length: remainingSlots }, (_, index) => (
              <div
                key={`placeholder-${index}`}
                className="flex aspect-video items-center justify-center rounded-xl border border-dashed border-white/15 bg-card/40 text-xs text-slate-500"
              >
                Preview {previews.length + index + 1}
              </div>
            ))}
          </div>
        </section>

        <form
          className={[
            'rounded-2xl border border-white/10 bg-card/70 p-6 shadow-[0_12px_40px_rgba(15,13,30,0.35)] transition-opacity',
            isCloneRunning ? 'pointer-events-none opacity-60' : 'opacity-100',
          ].join(' ')}
          onSubmit={handleCloneSubmit}
        >
          <h2 className="text-3xl font-semibold tracking-tight text-slate-100">Clone Settings</h2>

          <div className="mt-5 grid gap-4">
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="font-medium">
                Project Name <span className="text-red-300">*</span>
              </span>
              <input
                type="text"
                value={config.projectName}
                onChange={handleConfigChange('projectName')}
                disabled={isCloneRunning}
                className="rounded-lg border border-white/10 bg-surface/80 px-4 py-2.5 text-base text-slate-100 outline-none transition-colors focus:border-primary"
                placeholder="my-landing-page"
              />
              {errors.projectName ? (
                <span className="text-xs text-red-300">{errors.projectName}</span>
              ) : null}
            </label>

            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="font-medium">GitHub Repo URL</span>
              <input
                type="text"
                value={config.githubRepoUrl}
                onChange={handleConfigChange('githubRepoUrl')}
                disabled={isCloneRunning}
                className="rounded-lg border border-white/10 bg-surface/80 px-4 py-2.5 text-base text-slate-100 outline-none transition-colors focus:border-primary"
                placeholder="https://github.com/..."
              />
              {errors.githubRepoUrl ? (
                <span className="text-xs text-red-300">{errors.githubRepoUrl}</span>
              ) : null}
            </label>

            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="font-medium">GitHub Token</span>
              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-surface/80 px-3">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={config.githubToken}
                  onChange={handleConfigChange('githubToken')}
                  disabled={isCloneRunning}
                  className="w-full border-none bg-transparent px-1 py-2.5 text-base text-slate-100 outline-none"
                  placeholder="ghp_xxxxxxxxx"
                />
                <button
                  type="button"
                  className="rounded p-1.5 text-slate-300 transition-colors hover:bg-white/10 hover:text-slate-100"
                  onClick={() => setShowToken((current) => !current)}
                  disabled={isCloneRunning}
                  aria-label={showToken ? 'Hide GitHub token' : 'Show GitHub token'}
                >
                  <span className="sr-only">
                    {showToken ? 'Hide GitHub token value' : 'Show GitHub token value'}
                  </span>
                  {showToken ? (
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 4l16 16" />
                      <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                      <path d="M9.4 5.5A10.6 10.6 0 0 1 12 5c5.2 0 9.4 4.4 10 7-.2.9-.9 2.3-2 3.6" />
                      <path d="M6.2 6.2C4 7.7 2.5 9.8 2 12c.7 2.7 4.9 7 10 7 1.7 0 3.3-.4 4.6-1.1" />
                    </svg>
                  ) : (
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </label>

            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="font-medium">Max Iterations</span>
              <input
                type="number"
                min={1}
                value={config.maxIterations}
                onChange={handleConfigChange('maxIterations')}
                disabled={isCloneRunning}
                className="rounded-lg border border-white/10 bg-surface/80 px-4 py-2.5 text-base text-slate-100 outline-none transition-colors focus:border-primary"
              />
              {errors.maxIterations ? (
                <span className="text-xs text-red-300">{errors.maxIterations}</span>
              ) : null}
            </label>

            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="font-medium">Target Similarity (%)</span>
              <input
                type="number"
                min={50}
                max={100}
                value={config.targetSimilarity}
                onChange={handleConfigChange('targetSimilarity')}
                disabled={isCloneRunning}
                className="rounded-lg border border-white/10 bg-surface/80 px-4 py-2.5 text-base text-slate-100 outline-none transition-colors focus:border-primary"
              />
              {errors.targetSimilarity ? (
                <span className="text-xs text-red-300">{errors.targetSimilarity}</span>
              ) : null}
            </label>
          </div>

          <button
            type="submit"
            className="mt-6 w-full rounded-lg bg-primary px-5 py-3 text-lg font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!canStart || isCloneRunning}
          >
            🚀 Start Cloning
          </button>
        </form>
      </section>

      <aside className="pointer-events-none fixed right-5 top-5 z-50 flex w-96 max-w-[calc(100vw-2.5rem)] flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="rounded-lg border border-red-300/30 bg-red-500/15 px-4 py-3 text-sm text-red-100 shadow-lg backdrop-blur"
          >
            {toast.message}
          </div>
        ))}
      </aside>
    </main>
  );
}

export default App;
