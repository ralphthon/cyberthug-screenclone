import '@testing-library/jest-dom';

type LocalStorageMap = Map<string, string>;

function createLocalStorageShim() {
  const storage: LocalStorageMap = new Map();

  return {
    getItem: (key: string): string | null => (storage.has(key) ? storage.get(key) ?? null : null),
    setItem: (key: string, value: string): void => {
      storage.set(String(key), String(value));
    },
    removeItem: (key: string): void => {
      storage.delete(key);
    },
    clear: (): void => {
      storage.clear();
    },
    key: (index: number): string | null => {
      const keys = Array.from(storage.keys());
      return keys[index] ?? null;
    },
    get length(): number {
      return storage.size;
    },
  };
}

if (typeof window !== 'undefined' && typeof window.localStorage?.clear !== 'function') {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: createLocalStorageShim(),
  });
}

if (typeof window !== 'undefined' && typeof window.scrollTo !== 'function') {
  Object.defineProperty(window, 'scrollTo', {
    configurable: true,
    value: () => {},
  });
}

if (typeof Element !== 'undefined' && typeof Element.prototype.scrollTo !== 'function') {
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    value: () => {},
  });
}
