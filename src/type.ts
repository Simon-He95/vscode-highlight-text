export interface UserConfig {
  match: string[]
  [key: string]: any
}

export type ClearStyle = Record<string, (() => void)[]>
