/**
 * 前端运行时模块（i18n 等）在 import 期就会读 localStorage / navigator。
 * 面板的 node 测试环境没有这些浏览器全局，这里提供最小可用替身，
 * 只做到"能安全 import"，不模拟浏览器渲染。
 */
const store = new Map<string, string>();

const localStorageStub = {
  getItem: (key: string): string | null => store.get(key) ?? null,
  setItem: (key: string, value: string): void => {
    store.set(key, value);
  },
  removeItem: (key: string): void => {
    store.delete(key);
  },
  clear: (): void => {
    store.clear();
  },
  key: (index: number): string | null => Array.from(store.keys())[index] ?? null,
  get length(): number {
    return store.size;
  },
};

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: localStorageStub, configurable: true });
}

if (typeof globalThis.navigator === 'undefined') {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN' },
    configurable: true,
  });
}

if (typeof globalThis.window === 'undefined') {
  Object.defineProperty(globalThis, 'window', {
    value: {
      localStorage: localStorageStub,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    },
    configurable: true,
  });
}
