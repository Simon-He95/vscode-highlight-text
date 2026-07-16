import type { CompiledPattern, PatternInput } from './type'

const VALID_FLAGS = /^[dgimsuvy]*$/
const MAX_PATTERN_LENGTH = 1000

export function normalizeFlags(flags = 'gm'): string {
  if (!VALID_FLAGS.test(flags))
    throw new Error(`Invalid regular expression flags: ${flags}`)
  try {
    const validationRegex = new RegExp('', flags)
    void validationRegex
  }
  catch {
    throw new Error(`Invalid regular expression flags: ${flags}`)
  }

  const normalized = new Set(flags)
  normalized.add('g')
  normalized.add('d')
  return [...normalized].join('')
}

export function compilePattern(input: PatternInput): CompiledPattern {
  const source = typeof input === 'string' ? input : input[0]
  const flags = typeof input === 'string' ? 'gm' : input[1]
  if (!source)
    throw new Error('Regular expression pattern cannot be empty')
  if (source.length > MAX_PATTERN_LENGTH)
    throw new Error(`Regular expression pattern exceeds ${MAX_PATTERN_LENGTH} characters`)

  const normalizedFlags = normalizeFlags(flags)
  const regex = new RegExp(source, normalizedFlags)
  return { source: regex.source, flags: normalizedFlags }
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
      if (group?.hasQuantifier && quantifierEnd(source, index + 1) !== undefined)
        return false
      if (group?.hasQuantifier && groups.length)
        groups[groups.length - 1].hasQuantifier = true
      continue
    }
    const end = quantifierEnd(source, index)
    if (end !== undefined && !(character === '?' && source[index - 1] === '(')) {
      const group = groups.at(-1)
      if (group)
        group.hasQuantifier = true
      index = end
    }
  }
  return true
}

function quantifierEnd(source: string, index: number): number | undefined {
  const character = source[index]
  if (character === '*' || character === '+' || character === '?')
    return index
  if (character !== '{' || !isDigit(source[index + 1]))
    return
  let cursor = index + 2
  while (isDigit(source[cursor]))
    cursor++
  if (source[cursor] === '}')
    return cursor
  if (source[cursor] !== ',')
    return
  cursor++
  while (isDigit(source[cursor]))
    cursor++
  return source[cursor] === '}' ? cursor : undefined
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9'
}

export function advanceStringIndex(text: string, index: number, unicode: boolean): number {
  if (!unicode)
    return index + 1
  const first = text.charCodeAt(index)
  if (first < 0xD800 || first > 0xDBFF || index + 1 >= text.length)
    return index + 1
  const second = text.charCodeAt(index + 1)
  return second >= 0xDC00 && second <= 0xDFFF ? index + 2 : index + 1
}

export function safeMatchAll(text: string, regex: RegExp, maxIterations = 1000): RegExpExecArray[] {
  if (!regex.global)
    throw new Error('Regular expression must have the global flag set')

  const results: RegExpExecArray[] = []
  regex.lastIndex = 0
  let match: RegExpExecArray | null
  while (results.length < maxIterations && (match = regex.exec(text)) !== null) {
    results.push(match)
    if (match.index === regex.lastIndex) {
      const unicodeSets = Boolean((regex as RegExp & { unicodeSets?: boolean }).unicodeSets)
      regex.lastIndex = advanceStringIndex(text, regex.lastIndex, regex.unicode || unicodeSets)
    }
  }
  return results
}
