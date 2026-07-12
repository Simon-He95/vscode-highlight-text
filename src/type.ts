import type { DecorationRenderOptions } from 'vscode'

export type PatternInput = string | [string, string]

export interface UserConfig extends DecorationRenderOptions {
  match: PatternInput[] | string
  colors?: string[]
  ignoreReg?: PatternInput[]
  matchCss?: DecorationRenderOptions[]
  background?: string
}

export interface CompiledPattern {
  source: string
  flags: string
}

export interface CompiledTarget {
  decorationId?: string
  groupIndex?: number
  styleId: string
}

export interface CompiledRule {
  context: string
  id: string
  ignores: CompiledPattern[]
  pattern: CompiledPattern
  targets: CompiledTarget[]
}

export interface CompiledConfig {
  languages: Map<string, {
    dark: CompiledRule[]
    light: CompiledRule[]
  }>
  styles: Map<string, DecorationRenderOptions>
  warnings: string[]
}

export interface MatchResult {
  fullSpan?: [number, number]
  spans: Array<[number, number] | undefined>
}
