import process from 'node:process'
import { afterEach, beforeEach, vi } from 'vitest'

// 全局测试设置
beforeEach(() => {
  // 重置所有mock
  vi.clearAllMocks()
})

afterEach(() => {
  // 清理定时器和异步操作
  vi.clearAllTimers()
  vi.useRealTimers()
})

// 增强控制台输出用于测试
const originalConsole = console
globalThis.console = {
  ...originalConsole,
  warn: vi.fn(originalConsole.warn),
  error: vi.fn(originalConsole.error),
  log: vi.fn(originalConsole.log),
}

// 模拟performance API
if (typeof performance === 'undefined') {
  globalThis.performance = {
    now: vi.fn(() => Date.now()),
    mark: vi.fn(),
    measure: vi.fn(),
    clearMarks: vi.fn(),
    clearMeasures: vi.fn(),
    getEntriesByName: vi.fn(() => []),
    getEntriesByType: vi.fn(() => []),
    getEntries: vi.fn(() => []),
  } as any
}

// 设置测试环境变量
process.env.NODE_ENV = 'test'
