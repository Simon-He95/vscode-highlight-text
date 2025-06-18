import { createLog } from '@vscode-use/utils'

const logger = createLog('vscode-highlight-text')
logger.info('vscode-highlight activate')
export function isReg(o: any): o is RegExp {
  return typeof o === 'object' && o.constructor === RegExp
}

export function safeReplace(str: string, regex: RegExp, replacement: (substring: string, ...args: any[]) => string, maxIterations: number = 1000) {
  let iterations = 0
  return str.replace(regex, (...args) => {
    iterations++
    if (iterations > maxIterations) {
      logger.error(`Infinite loop detected in regular expression with ${regex}`)
      throw new Error(`Infinite loop detected in regular expression with ${regex}`)
    }

    return replacement(...args)
  })
}

export function safeMatchAll(text: string, regex: RegExp, maxIterations = 1000) {
  if (!regex.global) {
    logger.error('Regular expression must have the global flag set')
    throw new Error('Regular expression must have the global flag set')
  }

  // 检查文本大小，防止在大文本上执行复杂正则
  if (text.length > 100000) {
    logger.warn('Text too large for regex matching, truncating')
    text = text.substring(0, 100000)
  }

  const results = []
  let match
  let iterations = 0
  const startTime = Date.now()
  const maxTime = 5000 // 最大执行时间5秒

  // 重置正则的lastIndex，防止状态污染
  regex.lastIndex = 0

  while ((match = regex.exec(text)) !== null) {
    iterations++

    // 检查执行次数
    if (iterations > maxIterations) {
      logger.warn(`Infinite loop detected in regular expression with ${regex}`)
      break
    }

    // 检查执行时间
    if (Date.now() - startTime > maxTime) {
      logger.warn(`Regex execution timeout after ${maxTime}ms`)
      break
    }

    // 防止零宽度匹配导致的无限循环
    if (match.index === regex.lastIndex) {
      regex.lastIndex++
    }

    results.push(match)

    // 如果结果数量过多，可能存在问题
    if (results.length > 10000) {
      logger.warn('Too many regex matches, stopping execution')
      break
    }
  }

  return results
}
