import type { CompiledPattern, PatternInput } from './type'

const VALID_FLAGS = /^[dgimsuvy]*$/
const MAX_PATTERN_LENGTH = 1000

export function normalizeFlags(flags = 'gm'): string {
  if (!VALID_FLAGS.test(flags))
    throw new Error(`Invalid regular expression flags: ${flags}`)

  const normalized = new Set(flags)
  normalized.delete('y')
  normalized.add('g')
  normalized.add('d')
  return [...normalized].join('')
}

export function compilePattern(input: PatternInput): CompiledPattern {
  const [source, flags] = typeof input === 'string' ? [input, 'gm'] : input
  if (!source)
    throw new Error('Regular expression pattern cannot be empty')
  if (source.length > MAX_PATTERN_LENGTH)
    throw new Error(`Regular expression pattern exceeds ${MAX_PATTERN_LENGTH} characters`)

  const normalizedFlags = normalizeFlags(flags || 'gm')
  const regex = new RegExp(source, normalizedFlags)
  if (!isRegexSafe(regex))
    throw new Error(`Potentially unsafe regular expression: ${source}`)

  return { source, flags: normalizedFlags }
}

export function isPatternTuple(value: unknown): value is [string, string] {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === 'string'
    && typeof value[1] === 'string'
    && VALID_FLAGS.test(value[1])
}

export function normalizePatterns(value: unknown): PatternInput[] {
  if (typeof value === 'string')
    return [value]
  if (!Array.isArray(value))
    return []

  return value.filter((item): item is PatternInput => typeof item === 'string' || isPatternTuple(item))
}

/**
 * Rejects common nested-quantifier forms. This is only an early warning;
 * execution is isolated in a worker to provide the actual timeout boundary.
 */
export function isRegexSafe(regex: RegExp): boolean {
  const source = regex.source
  if (source.length > MAX_PATTERN_LENGTH)
    return false

  const groups: Array<{ hasQuantifier: boolean }> = []
  let inCharacterClass = false
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (character === '\\') {
      index++
      continue
    }
    if (character === '[') {
      inCharacterClass = true
      continue
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false
      continue
    }
    if (inCharacterClass)
      continue
    if (character === '(') {
      groups.push({ hasQuantifier: false })
      continue
    }
    if (character === ')') {
      const group = groups.pop()
      if (group?.hasQuantifier && isQuantifierAt(source, index + 1))
        return false
      continue
    }
    if (isQuantifierAt(source, index) && !(character === '?' && source[index - 1] === '(')) {
      groups.forEach(group => group.hasQuantifier = true)
      if (character === '{') {
        const end = source.indexOf('}', index + 1)
        if (end >= 0)
          index = end
      }
    }
  }
  return true
}

function isQuantifierAt(source: string, index: number): boolean {
  const character = source[index]
  if (character === '*' || character === '+' || character === '?')
    return true
  if (character !== '{')
    return false
  return /^\{\d+(?:,\d*)?\}/.test(source.slice(index))
}

export function safeMatchAll(text: string, regex: RegExp, maxIterations = 1000): RegExpExecArray[] {
  if (!regex.global)
    throw new Error('Regular expression must have the global flag set')

  const results: RegExpExecArray[] = []
  regex.lastIndex = 0
  let match: RegExpExecArray | null
  while (results.length < maxIterations && (match = regex.exec(text)) !== null) {
    results.push(match)
    if (match.index === regex.lastIndex)
      regex.lastIndex++
  }
  return results
}
