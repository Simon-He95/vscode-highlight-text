import type { DecorationRenderOptions } from 'vscode'
import type { CompiledConfig, CompiledRule, CompiledTarget, PatternInput, UserConfig } from './type'
import { createFilter } from '@rollup/pluginutils'
import { DecorationRangeBehavior } from 'vscode'
import { compilePattern, isPatternTuple, isRegexSafe, normalizePatterns } from './regex'

const MAX_IGNORE_PATTERNS_PER_RULE = 100
const MAX_LANGUAGES = 100
const MAX_LANGUAGE_KEY_LENGTH = 1000
const MAX_RULES_PER_MODE = 1000
const MAX_TARGETS_PER_RULE = 100
const MAX_TOTAL_RULES = 5000
const MAX_TOTAL_STYLES = 1000
const MAX_WARNINGS = 100
const STYLE_ONLY_FIELDS = new Set(['match', 'colors', 'matchCss', 'ignoreReg', 'background'])

interface CompilationBudget {
  remainingInputs: number
}

function normalizePatternsWithBudget(value: unknown, budget: CompilationBudget, maxItems: number): PatternInput[] {
  if (budget.remainingInputs <= 0)
    return []
  if (!Array.isArray(value)) {
    budget.remainingInputs--
    return normalizePatterns(value)
  }
  const count = Math.min(value.length, maxItems, budget.remainingInputs)
  budget.remainingInputs -= count
  return normalizePatterns(value.slice(0, count))
}

function createWarnings(): string[] {
  const warnings: string[] = []
  Object.defineProperty(warnings, 'push', {
    configurable: true,
    value: (...items: string[]) => Array.prototype.push.apply(
      warnings,
      items.slice(0, Math.max(0, MAX_WARNINGS - warnings.length)),
    ),
    writable: true,
  })
  return warnings
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableSerialize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function normalizeStyle(raw: Record<string, unknown>): DecorationRenderOptions {
  const style: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!STYLE_ONLY_FIELDS.has(key))
      style[key] = value
  }
  if (raw.background !== undefined && style.backgroundColor === undefined)
    style.backgroundColor = raw.background
  return style as DecorationRenderOptions
}

function addStyle(config: CompiledConfig, style: DecorationRenderOptions): string {
  const id = stableSerialize(style)
  if (!config.styles.has(id)) {
    if (config.styles.size >= MAX_TOTAL_STYLES)
      throw new Error(`Configuration exceeds ${MAX_TOTAL_STYLES} unique styles`)
    config.styles.set(id, style)
  }
  return id
}

function isStyleObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function compileTargets(
  option: Record<string, unknown> | undefined,
  base: Record<string, unknown>,
  commonStyle: DecorationRenderOptions,
  context: string,
  config: CompiledConfig,
): CompiledTarget[] | undefined {
  if (option && 'matchCss' in option) {
    if (!Array.isArray(option.matchCss)) {
      config.warnings.push(`Invalid matchCss for ${context}: expected an array of style objects`)
      return
    }
    if (option.matchCss.length > MAX_TARGETS_PER_RULE) {
      config.warnings.push(`Invalid matchCss for ${context}: at most ${MAX_TARGETS_PER_RULE} targets are allowed`)
      return
    }
    const styles = option.matchCss.filter(isStyleObject)
    if (styles.length !== option.matchCss.length) {
      config.warnings.push(`Invalid matchCss entries for ${context}: expected style objects`)
      return
    }
    if (!styles.length) {
      config.warnings.push(`Invalid matchCss for ${context}: at least one style is required`)
      return
    }
    return styles.map((style, index) => ({
      groupIndex: index + 1,
      styleId: addStyle(config, normalizeStyle({ ...base, ...style })),
    }))
  }

  if (option && 'colors' in option) {
    if (!Array.isArray(option.colors)) {
      config.warnings.push(`Invalid colors for ${context}: expected an array of strings`)
      return
    }
    if (option.colors.length > MAX_TARGETS_PER_RULE) {
      config.warnings.push(`Invalid colors for ${context}: at most ${MAX_TARGETS_PER_RULE} targets are allowed`)
      return
    }
    const colors = option.colors.filter((value): value is string => typeof value === 'string')
    if (colors.length !== option.colors.length) {
      config.warnings.push(`Invalid colors entries for ${context}: expected strings`)
      return
    }
    if (!colors.length) {
      config.warnings.push(`Invalid colors for ${context}: at least one color is required`)
      return
    }
    return colors.map((color, index) => ({
      groupIndex: index + 1,
      styleId: addStyle(config, normalizeStyle({ ...base, color })),
    }))
  }

  return [{ styleId: addStyle(config, commonStyle) }]
}

function compileStyleRules(
  color: string,
  raw: unknown,
  context: string,
  config: CompiledConfig,
  budget: CompilationBudget,
): CompiledRule[] {
  const base: Record<string, unknown> = {
    color,
    isWholeLine: false,
    rangeBehavior: DecorationRangeBehavior.ClosedClosed,
  }
  const option = isStyleObject(raw) ? raw as UserConfig & Record<string, unknown> : undefined
  let patterns: PatternInput[]
  if (option) {
    patterns = normalizePatternsWithBudget(option.match, budget, MAX_RULES_PER_MODE)
  }
  else {
    patterns = normalizePatternsWithBudget(raw, budget, MAX_RULES_PER_MODE)
    if (isPatternTuple(raw))
      config.warnings.push(`Ambiguous rule for ${context}: interpreted as two patterns; wrap it in an array, for example [["pattern", "gm"]], to pass flags`)
  }
  if (!patterns.length) {
    config.warnings.push(`Invalid match patterns for ${context}`)
    return []
  }
  if (patterns.length > MAX_RULES_PER_MODE) {
    config.warnings.push(`Too many match patterns for ${context}: at most ${MAX_RULES_PER_MODE} patterns are allowed`)
    patterns = patterns.slice(0, MAX_RULES_PER_MODE)
  }

  const commonStyle = normalizeStyle({ ...base, ...(option ?? {}) })
  const targets = compileTargets(option, base, commonStyle, context, config)
  if (!targets)
    return []

  let ignores: ReturnType<typeof compilePattern>[] = []
  if (option && 'ignoreReg' in option) {
    if (Array.isArray(option.ignoreReg) && option.ignoreReg.length > MAX_IGNORE_PATTERNS_PER_RULE) {
      config.warnings.push(`Invalid ignoreReg for ${context}: at most ${MAX_IGNORE_PATTERNS_PER_RULE} patterns are allowed`)
      return []
    }
    if (!Array.isArray(option.ignoreReg)) {
      config.warnings.push(`Invalid ignoreReg for ${context}: expected an array of patterns`)
      return []
    }
    if (option.ignoreReg.length > budget.remainingInputs) {
      config.warnings.push(`Configuration input budget was reached while compiling ignoreReg for ${context}`)
      return []
    }
    const ignorePatterns = normalizePatternsWithBudget(option.ignoreReg, budget, MAX_IGNORE_PATTERNS_PER_RULE)
    if (ignorePatterns.length !== option.ignoreReg.length) {
      config.warnings.push(`Invalid ignoreReg entries for ${context}: expected patterns`)
      return []
    }
    let invalidIgnore = false
    ignores = ignorePatterns.flatMap((input) => {
      try {
        const pattern = compilePattern(input)
        if (!isRegexSafe(new RegExp(pattern.source, pattern.flags)))
          config.warnings.push(`Potentially expensive ignoreReg for ${context}: ${pattern.source}`)
        return [pattern]
      }
      catch (error) {
        invalidIgnore = true
        config.warnings.push(`Invalid ignoreReg for ${context}: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    })
    if (invalidIgnore)
      return []
  }

  return patterns.flatMap((input) => {
    try {
      const pattern = compilePattern(input)
      if (!isRegexSafe(new RegExp(pattern.source, pattern.flags)))
        config.warnings.push(`Potentially expensive regular expression for ${context}: ${pattern.source}`)
      return [{
        context,
        id: JSON.stringify([context, pattern.source, pattern.flags]),
        ignores,
        pattern,
        targets,
      }]
    }
    catch (error) {
      config.warnings.push(`Invalid pattern for ${context}: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  })
}

function compileMode(raw: unknown, language: string, mode: 'dark' | 'light', config: CompiledConfig, budget: CompilationBudget, maxRules = MAX_RULES_PER_MODE): CompiledRule[] {
  if (!isStyleObject(raw))
    return []
  const rules: CompiledRule[] = []
  for (const color in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, color))
      continue
    if (budget.remainingInputs <= 0) {
      config.warnings.push('Configuration input budget was reached; remaining style entries were skipped')
      break
    }
    if (rules.length >= maxRules) {
      config.warnings.push(`Too many rules for ${language}.${mode}: at most ${MAX_RULES_PER_MODE} rules are allowed`)
      break
    }
    budget.remainingInputs--
    const value = raw[color]
    const previousStyleIds = new Set(config.styles.keys())
    try {
      const remaining = maxRules - rules.length
      const compiled = compileStyleRules(color, value, `${language}.${mode}.${color}`, config, budget).slice(0, remaining)
      if (!compiled.length) {
        for (const styleId of config.styles.keys()) {
          if (!previousStyleIds.has(styleId))
            config.styles.delete(styleId)
        }
      }
      rules.push(...compiled)
    }
    catch (error) {
      for (const styleId of config.styles.keys()) {
        if (!previousStyleIds.has(styleId))
          config.styles.delete(styleId)
      }
      config.warnings.push(`Invalid configuration for ${language}.${mode}.${color}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return rules
}

export function compileConfig(raw: unknown): CompiledConfig {
  const result: CompiledConfig = {
    languages: new Map(),
    styles: new Map(),
    warnings: createWarnings(),
  }
  if (!isStyleObject(raw)) {
    result.warnings.push('vscode-highlight-text.rules must be an object')
    return result
  }

  let compiledRuleCount = 0
  const compilationBudget: CompilationBudget = { remainingInputs: MAX_TOTAL_RULES }
  let processedLanguageKeys = 0
  for (const languageKey in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, languageKey))
      continue
    if (processedLanguageKeys >= MAX_LANGUAGES || compiledRuleCount >= MAX_TOTAL_RULES || compilationBudget.remainingInputs <= 0) {
      result.warnings.push('Configuration compilation budget was reached; remaining language keys were skipped')
      break
    }
    processedLanguageKeys++
    compilationBudget.remainingInputs--
    if (languageKey.length > MAX_LANGUAGE_KEY_LENGTH) {
      result.warnings.push(`Language key exceeds ${MAX_LANGUAGE_KEY_LENGTH} characters and was skipped`)
      continue
    }
    const modes = raw[languageKey]
    if (!isStyleObject(modes)) {
      result.warnings.push(`Rules for ${languageKey} must be an object`)
      continue
    }
    let availableLanguages = MAX_LANGUAGES - result.languages.size
    const languages: string[] = []
    let segmentStart = 0
    for (let index = 0; index <= languageKey.length && languages.length < MAX_LANGUAGES; index++) {
      if (index < languageKey.length && languageKey[index] !== '|')
        continue
      const language = languageKey.slice(segmentStart, index).trim()
      segmentStart = index + 1
      if (!language || languages.includes(language))
        continue
      if (result.languages.has(language)) {
        languages.push(language)
      }
      else if (availableLanguages > 0) {
        availableLanguages--
        languages.push(language)
      }
      if (availableLanguages <= 0 && languages.every(item => !result.languages.has(item)))
        break
    }
    if (!languages.length) {
      result.warnings.push(`Too many languages: at most ${MAX_LANGUAGES} languages are allowed`)
      continue
    }

    const darkLimit = Math.min(MAX_RULES_PER_MODE, MAX_TOTAL_RULES - compiledRuleCount)
    const dark = compileMode(modes.dark, languageKey, 'dark', result, compilationBudget, darkLimit)
    compiledRuleCount += dark.length
    const lightLimit = Math.min(MAX_RULES_PER_MODE, MAX_TOTAL_RULES - compiledRuleCount)
    const light = compileMode(modes.light, languageKey, 'light', result, compilationBudget, lightLimit)
    compiledRuleCount += light.length
    const compiled = { dark, light }

    for (const language of languages) {
      const existing = result.languages.get(language)
      if (!existing) {
        result.languages.set(language, compiled)
        continue
      }
      const mergedDark = [...compiled.dark, ...existing.dark]
      const mergedLight = [...compiled.light, ...existing.light]
      if (mergedDark.length > MAX_RULES_PER_MODE || mergedLight.length > MAX_RULES_PER_MODE)
        result.warnings.push(`Too many merged rules for ${language}: at most ${MAX_RULES_PER_MODE} rules per mode are allowed`)
      result.languages.set(language, {
        dark: mergedDark.slice(0, MAX_RULES_PER_MODE),
        light: mergedLight.slice(0, MAX_RULES_PER_MODE),
      })
    }
  }

  let totalRules = 0
  let rulesTruncated = false
  const usedStyleIds = new Set<string>()
  for (const [language, modes] of result.languages) {
    const limitMode = (rules: CompiledRule[]) => rules.filter((rule) => {
      if (totalRules >= MAX_TOTAL_RULES) {
        rulesTruncated = true
        return false
      }
      totalRules++
      rule.targets.forEach(target => usedStyleIds.add(target.styleId))
      return true
    })
    result.languages.set(language, { dark: limitMode(modes.dark), light: limitMode(modes.light) })
  }
  if (rulesTruncated)
    result.warnings.push(`Configuration is limited to ${MAX_TOTAL_RULES} total language-mode rule entries`)
  for (const styleId of result.styles.keys()) {
    if (!usedStyleIds.has(styleId))
      result.styles.delete(styleId)
  }
  return result
}

export function createExcludeFilter(value: unknown): (path: string) => boolean {
  const excludes = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  return createFilter(undefined, excludes)
}

export function getRulesForLanguage(config: CompiledConfig, languageId: string, dark: boolean, warnings?: string[]): CompiledRule[] {
  const aliases: Record<string, string[]> = {
    javascriptreact: ['javascriptreact', 'typescriptreact', 'react'],
    markdown: ['markdown', 'md'],
    plaintext: ['plaintext', 'txt'],
    typescriptreact: ['typescriptreact', 'javascriptreact', 'react'],
    vuetsx: ['vuetsx', 'vue'],
  }
  const languages = aliases[languageId] ?? [languageId]
  const mode = dark ? 'dark' : 'light'
  const rules = [...new Set(languages.flatMap(language => config.languages.get(language)?.[mode] ?? []))]
  if (rules.length > MAX_RULES_PER_MODE)
    warnings?.push(`Rules for ${languageId}.${mode} were limited to ${MAX_RULES_PER_MODE} after alias merging`)
  return rules.slice(0, MAX_RULES_PER_MODE)
}
