import { addEventListener, createRange, createStyle, getActiveText, setStyle, getActiveTextEditorLanguageId, getConfiguration, getPosition } from '@vscode-use/utils'
import type { Disposable, ExtensionContext } from 'vscode'

export async function activate(context: ExtensionContext) {
  const disposes: Disposable[] = []

  const userConfigurationStyle = getConfiguration('vscode-highlight-v-if.style')
  const style = createStyle(userConfigurationStyle)
  // const setStyle = (style: any, range: any) => {
  //   const activeTextEditor = getActiveTextEditor()
  //   if (!activeTextEditor)
  //     return

  //   const rangeOrOptins = range
  //     ? (range as any).length
  //         ? range
  //         : [range]
  //     : []
  //   return activeTextEditor.setDecorations(style, rangeOrOptins as any[])
  // }
  const updateVIfStyle = () => {
    const isVue = getActiveTextEditorLanguageId() === 'vue'
    const text = getActiveText()
    if (!text || !isVue)
      return
    const ranges: any = []
    for (const matcher of text.matchAll(/(v-if|v-else-if|v-else)/g)) {
      const start = matcher.index!
      const end = start + matcher[0].length
      const range = createRange(getPosition(start), getPosition(end))
      ranges.push(range)
    }
    setStyle(style, ranges)
  }
  updateVIfStyle()
  disposes.push(addEventListener('text-change', updateVIfStyle))
  disposes.push(addEventListener('activeText-change', updateVIfStyle))
  context.subscriptions.push(...disposes)
}

export function deactivate() {

}
