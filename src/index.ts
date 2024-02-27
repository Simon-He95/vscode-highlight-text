import { addEventListener, createRange, createStyle, getActiveText, getActiveTextEditorLanguageId, getConfiguration, getPosition, isDark, setStyle } from '@vscode-use/utils'
import type { Disposable, ExtensionContext } from 'vscode'

export interface UserConfig {
  match: string[]
  [key: string]: any
}
export function isReg(o: any): o is RegExp {
  return typeof o === 'object' && o.constructor === RegExp
}
export async function activate(context: ExtensionContext) {
  const disposes: Disposable[] = []

  const userConfigurationStyle = getConfiguration('vscode-vue-highlight.rules')[isDark() ? 'dark' : 'light']
  const clearStyle: (() => void)[] = []
  const updateVStyle = () => {
    const isVue = getActiveTextEditorLanguageId() === 'vue'
    const text = getActiveText()
    clearStyle.forEach(cb => cb())
    clearStyle.length = 0
    if (!text || !isVue)
      return
    for (const color in userConfigurationStyle) {
      let option = userConfigurationStyle[color] as string[] | UserConfig
      const ranges: any = []

      let styleOption = { color }
      if (!Array.isArray(option) && option.match) {
        styleOption = Object.assign({}, option) as any
        option = option.match
      }
      const style = createStyle(styleOption)
      if (Array.isArray(option) && option.length) {
        const reg = new RegExp(option.join('|'), 'g')
        for (const matcher of text.matchAll(reg)) {
          const start = matcher[1] ? matcher.index! + matcher[0].indexOf(matcher[1]) : matcher.index!
          const end = start + (matcher[1] ? matcher[1].length : matcher[0].length)
          const range = createRange(getPosition(start), getPosition(end))
          ranges.push(range)
        }
        if (ranges.length)
          setStyle(style, ranges)

        clearStyle.push(() => setStyle(style))
      }
    }
  }
  updateVStyle()
  disposes.push(addEventListener('text-change', updateVStyle))
  disposes.push(addEventListener('activeText-change', updateVStyle))
  disposes.push(addEventListener('config-change', updateVStyle))
  context.subscriptions.push(...disposes)
}

export function deactivate() {

}
