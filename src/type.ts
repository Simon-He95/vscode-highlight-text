export interface UserConfig {
  match: (string | [string, string])[]
  [key: string]: any
}

export type ClearStyle = Record<string, (() => void)[]>
