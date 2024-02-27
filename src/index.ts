import { addEventListener, createRange, createStyle, getActiveText, getActiveTextEditorLanguageId, getConfiguration, getPosition, isDark, setStyle } from '@vscode-use/utils'
import type { Disposable, ExtensionContext } from 'vscode'

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
    const ranges: any = []
    let style: any
    for (const color in userConfigurationStyle) {
      const option = userConfigurationStyle[color]
      style = createStyle({ color })
      if (option.length) {
        const reg = new RegExp(option.join('|'), 'g')
        for (const matcher of text.matchAll(reg)) {
          const start = matcher.index!
          const end = start + matcher[0].length
          const range = createRange(getPosition(start), getPosition(end))
          ranges.push(range)
        }
        setStyle(style, ranges)
        clearStyle.push(() => setStyle(style))
      }
    }
  }
  updateVStyle()
  disposes.push(addEventListener('text-change', updateVStyle))
  disposes.push(addEventListener('activeText-change', updateVStyle))
  context.subscriptions.push(...disposes)
}

export function deactivate() {

}
