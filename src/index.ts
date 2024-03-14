import { addEventListener, createRange, createStyle, getActiveText, getActiveTextEditorLanguageId, getConfiguration, getCurrentFileUrl, getPosition, isDark, setStyle } from '@vscode-use/utils'
import type { Disposable, ExtensionContext } from 'vscode'

export interface UserConfig {
  match: string[]
  [key: string]: any
}
export function isReg(o: any): o is RegExp {
  return typeof o === 'object' && o.constructor === RegExp
}
const defaultConfig = {
  light: {
    'rgb(248 113 113)': {
      match: [
        'v-if',
        'v-else-if',
        'v-else',
      ],
      before: {
        contentText: '⭐️',
      },
    },
    '#B392F0': [
      'v-for',
    ],
    '#FFC83D': [
      '<template\\s+(\\#[^\\s\\/>]+)',
      'v-bind',
      'v-on',
      '(v-slot:[^>\\s\\/>]+)',
      'v-html',
      'v-text',
    ],
    'rgb(99, 102, 241)': [
      ':is',
    ],
    'rgb(14, 165, 233)': [
      'defineProps',
      'defineOptions',
      'defineEmits',
      'defineExpose',
    ],
  },
  dark: {
    'rgb(248 113 113)': {
      match: [
        'v-if',
        'v-else-if',
        'v-else',
      ],
      before: {
        contentText: '⭐️',
      },
    },
    '#B392F0': [
      'v-for',
    ],
    '#FFC83D': [
      '<template\\s+(\\#[^\\s\\/>]+)',
      'v-bind',
      'v-on',
      '(v-slot:[^>\\s\\/>]+)',
      'v-html',
      'v-text',
    ],
    'rgb(99, 102, 241)': {
      match: [
        ':is',
      ],
    },
    'rgb(14, 165, 233)': [
      'defineProps',
      'defineOptions',
      'defineEmits',
      'defineExpose',
    ],
  },
}
export async function activate(context: ExtensionContext) {
  const disposes: Disposable[] = []

  const clearStyle: Record<string, (() => void)[]> = {}
  const updateVStyle = () => {
    const currentFileUrl = getCurrentFileUrl()
    if (!currentFileUrl)
      return
    const isVue = getActiveTextEditorLanguageId() === 'vue'
    if (!isVue)
      return

    const userConfigurationStyle = getConfiguration('vscode-vue-highlight.rules', defaultConfig)[isDark() ? 'dark' : 'light']

    const cache = clearStyle[currentFileUrl]
    if (cache) {
      cache.forEach(cb => cb())
      cache.length = 0
    }
    const text = getActiveText()

    if (!text)
      return
    for (const color in userConfigurationStyle) {
      let option = userConfigurationStyle[color] as string[] | UserConfig
      const ranges: any = []

      let styleOption = { color, isWholeLine: false }
      if (!Array.isArray(option) && option.match) {
        styleOption = Object.assign({ color }, option, { after: option.after }, { before: option.before }) as any
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
        if (!clearStyle[currentFileUrl])
          clearStyle[currentFileUrl] = []
        clearStyle[currentFileUrl].push(() => setStyle(style))
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
