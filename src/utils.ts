export function isReg(o: any): o is RegExp {
  return typeof o === 'object' && o.constructor === RegExp
}

export function safeReplace(str: string, regex: RegExp, replacement: (substring: string, ...args: any[]) => string, maxIterations: number = 1000) {
  let iterations = 0
  return str.replace(regex, (...args) => {
    iterations++
    if (iterations > maxIterations)
      throw new Error(`Infinite loop detected in regular expression with ${regex}`)

    return replacement(...args)
  })
}

export function safeMatchAll(text: string, regex: RegExp, maxIterations = 1000) {
  if (!regex.global)
    throw new Error('Regular expression must have the global flag set')

  const results = []
  let match
  let iterations = 0

  while ((match = regex.exec(text)) !== null) {
    iterations++
    if (iterations > maxIterations) {
      console.warn(`Infinite loop detected in regular expression with ${regex}`)
      break
    }

    // 防止零宽度匹配导致的无限循环
    if (match.index === regex.lastIndex)
      regex.lastIndex++

    results.push(match)
  }

  return results
}
