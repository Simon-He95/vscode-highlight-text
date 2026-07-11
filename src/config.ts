import type { DecorationRenderOptions } from 'vscode'
import type { CompiledConfig, CompiledRule, PatternInput, UserConfig } from './type'
import { createFilter } from '@rollup/pluginutils'
import { DecorationRangeBehavior } from 'vscode'
import { compilePattern, normalizePatterns } from './regex'

const STYLE_ONLY_FIELDS = new Set(['match', 'colors', 'matchCss', 'ignoreReg', 'background'])

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
  if (!config.styles.has(id))
    config.styles.set(id, style)
  return id
}

function compileStyleRules(
  color: string,
  raw: unknown,
  config: CompiledConfig,
): CompiledRule[] {
  const base: Record<string, unknown> = {
    color,
    isWholeLine: false,
    rangeBehavior: DecorationRangeBehavior.ClosedClosed,
  }
  const option = raw && !Array.isArray(raw) && typeof raw === 'object' ? raw as UserConfig : undefined
  const patterns = normalizePatterns(option?.match ?? raw)
  if (!patterns.length)
    return []

  const commonStyle = normalizeStyle({ ...base, ...(option ?? {}) })
  const targets = option?.matchCss
    ? option.matchCss.map((style, index) => ({
        groupIndex: index + 1,
        styleId: addStyle(config, normalizeStyle({ ...base, ...style })),
      }))
    : option?.colors
      ? option.colors.map((targetColor, index) => ({
          groupIndex: index + 1,
          styleId: addStyle(config, normalizeStyle({ ...base, color: targetColor })),
        }))
      : [{ styleId: addStyle(config, commonStyle) }]

  const ignores = normalizePatterns(option?.ignoreReg)
    .flatMap((input) => {
      try {
        return [compilePattern(input)]
      }
      catch (error) {
        config.warnings.push(error instanceof Error ? error.message : String(error))
        return []
      }
    })

  return patterns.flatMap((input: PatternInput) => {
    try {
      return [{ ignores, pattern: compilePattern(input), targets }]
    }
    catch (error) {
      config.warnings.push(error instanceof Error ? error.message : String(error))
      return []
    }
  })
}

function compileMode(raw: unknown, config: CompiledConfig): CompiledRule[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return []
  return Object.entries(raw).flatMap(([color, value]) => compileStyleRules(color, value, config))
}

export function compileConfig(raw: unknown): CompiledConfig {
  const result: CompiledConfig = {
    languages: new Map(),
    styles: new Map(),
    warnings: [],
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    result.warnings.push('vscode-highlight-text.rules must be an object')
    return result
  }

  for (const [languageKey, modes] of Object.entries(raw)) {
    if (!modes || typeof modes !== 'object' || Array.isArray(modes)) {
      result.warnings.push(`Rules for ${languageKey} must be an object`)
      continue
    }
    const value = modes as Record<string, unknown>
    const compiled = {
      dark: compileMode(value.dark, result),
      light: compileMode(value.light, result),
    }
    for (const language of languageKey.split('|').map(item => item.trim()).filter(Boolean)) {
      const existing = result.languages.get(language)
      result.languages.set(language, existing
        ? { dark: [...compiled.dark, ...existing.dark], light: [...compiled.light, ...existing.light] }
        : compiled)
    }
  }
  return result
}

export function createExcludeFilter(value: unknown): (path: string) => boolean {
  const excludes = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  return createFilter(undefined, excludes)
}

export function getRulesForLanguage(config: CompiledConfig, languageId: string, dark: boolean): CompiledRule[] {
  const aliases: Record<string, string[]> = {
    javascriptreact: ['react', 'javascriptreact'],
    markdown: ['md', 'markdown'],
    plaintext: ['txt', 'plaintext'],
    typescriptreact: ['react', 'typescriptreact'],
    vuetsx: ['vue', 'vuetsx'],
  }
  const languages = aliases[languageId] ?? [languageId]
  const mode = dark ? 'dark' : 'light'
  return [...new Set(languages.flatMap(language => config.languages.get(language)?.[mode] ?? []))]
}
