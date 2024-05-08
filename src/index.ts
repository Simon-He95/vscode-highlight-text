import { addEventListener, createRange, createSelect, createStyle, getActiveText, getActiveTextEditorLanguageId, getConfiguration, getCurrentFileUrl, getPosition, isDark, message, nextTick, registerCommand, setConfiguration, setStyle } from '@vscode-use/utils'
import type { Disposable, ExtensionContext } from 'vscode'
import { deepMerge, isArray, isObject } from 'lazy-js-utils'
import templates from './template'

export interface UserConfig {
  match: string[]
  [key: string]: any
}
export function isReg(o: any): o is RegExp {
  return typeof o === 'object' && o.constructor === RegExp
}

const defaultConfig = {
  vue: {
    light: {
      'purple': {
        match: [
          'v-if',
          'v-else-if',
          'v-else',
        ],
        before: {
          contentText: '✨',
        },
      },
      '#B392F0': [
        'v-for',
      ],
      '#FFC83D': [
        '<template\\s+(\\#[^\\s\\/>=]+)',
        'v-bind',
        'v-once',
        'v-on',
        '(v-slot:[^>\\s\\/>]+)',
        'v-html',
        'v-text',
      ],
      'rgb(99, 102, 241)': [
        ':is',
      ],
      'rgb(14, 165, 233)': [
        '(defineProps)[<\\(]',
        'defineOptions',
        'defineEmits',
        'defineExpose',
      ],
    },
    dark: {
      'purple': {
        match: [
          'v-if',
          'v-else-if',
          'v-else',
        ],
        before: {
          contentText: '✨',
        },
      },
      '#B392F0': [
        'v-for',
      ],
      '#FFC83D': [
        '<template\\s+(\\#[^\\s\\/>=]+)',
        'v-bind',
        'v-once',
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
        '(defineProps)[<\\(]',
        'defineOptions',
        'defineEmits',
        'defineExpose',
      ],
    },
  },
  react: {
    light: {},
    dark: {},
  },
}
export async function activate(context: ExtensionContext) {
  const disposes: Disposable[] = []

  const clearStyle: Record<string, (() => void)[]> = {}
  const updateVStyle = () => {
    const currentFileUrl = getCurrentFileUrl(true)
    if (!currentFileUrl)
      return
    let lan = getActiveTextEditorLanguageId()
    if (!lan)
      return

    switch (lan) {
      case 'vue':
        lan = 'vue'
        break
      case 'javascriptreact':
      case 'typescriptreact':
        lan = 'react'
        break
      case 'svelte':
        lan = 'svelte'
        break
      case 'solid':
        lan = 'solid'
        break
      case 'astro':
        lan = 'astro'
    }
    // 支持 key 为 'a|b' 的形式
    const userConfigurationStyle = getUserConfigurationStyle(lan)?.[isDark() ? 'dark' : 'light']
    if (!userConfigurationStyle)
      return

    const cacheKey = currentFileUrl.fsPath + currentFileUrl.scheme
    const cache = clearStyle[cacheKey]
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
      let styleOption: any = { color, isWholeLine: false }
      if (!Array.isArray(option) && option.match) {
        styleOption = Object.assign({ color }, option, { after: option.after }, { before: option.before }) as any
        option = option.match
      }
      const style = createStyle(styleOption)
      if (Array.isArray(option) && option.length) {
        const reg = new RegExp(option.join('|'), 'gm')
        // 如果有 colors 字段
        const colors = styleOption.colors
        const matchCss = styleOption.matchCss
        for (const matcher of text.matchAll(reg)) {
          if (isArray(matchCss)) {
            for (let i = 0; i < matchCss.length; i++) {
              const option = matchCss[i]
              if (!option)
                break
              if (!isObject(option))
                return message.error('matchCss 类型错误')
              const style = createStyle(Object.assign({ color, isWholeLine: false }, option))
              const matchText = matcher[i + 1]
              if (matchText === undefined)
                break
              if (!matchText)
                continue
              const start = matcher.index! + matcher[0].indexOf(matchText)
              const end = start + (matchText.length)
              const range = createRange(getPosition(start), getPosition(end))
              setStyle(style, range)
              clearStyle[cacheKey].push(() => setStyle(style))
            }
          }
          else if (isArray(colors)) {
            for (let i = 0; i < colors.length; i++) {
              const c = colors[i]
              if (!c)
                continue
              const style = createStyle({ color: c, isWholeLine: false })
              const matchText = matcher[i + 1]
              if (matchText === undefined)
                break
              if (!matchText)
                continue
              const start = matcher.index! + matcher[0].indexOf(matchText)
              const end = start + (matchText.length)
              const range = createRange(getPosition(start), getPosition(end))
              setStyle(style, range)
              clearStyle[cacheKey].push(() => setStyle(style))
            }
          }
          else if (!colors) {
            let matchText
            // 忽略 undefined 的 match 项
            for (let i = 1; i < matcher.length; i++) {
              matchText = matcher[i]
              if (matchText !== undefined)
                break
            }
            if (!matchText)
              continue
            const start = matcher.index! + matcher[0].indexOf(matchText)
            const end = start + matchText.length
            const range = createRange(getPosition(start), getPosition(end))
            ranges.push(range)
          }
          else if (colors && !isArray(colors)) {
            return message.error(`colors 字段类型错误，需要是 colorsArray`)
          }
          else if (matchCss && !isArray(matchCss)) {
            return message.error(`matchCss 字段类型错误，需要是 styleArray`)
          }
        }
        if (ranges.length)
          setStyle(style, ranges)
        if (!clearStyle[cacheKey])
          clearStyle[cacheKey] = []
        clearStyle[cacheKey].push(() => setStyle(style))
      }
    }
  }
  updateVStyle()
  disposes.push(addEventListener('text-change', updateVStyle))
  disposes.push(addEventListener('activeText-change', updateVStyle))
  disposes.push(addEventListener('config-change', updateVStyle))
  disposes.push(addEventListener('theme-change', updateVStyle))
  disposes.push(registerCommand('vscode-highlight-text.selectTemplate', () => {
    const options = Object.keys(templates)
    if (!options.length)
      return
    createSelect(options).then((select) => {
      if (!select)
        return
      const templateConfig = (templates as any)[select]
      const userConfig = getConfiguration('vscode-highlight-text.rules')
      // 把用户的 config 和 模板的 config 合并
      const mergeConfig = deepMerge(userConfig, templateConfig)
      setConfiguration('vscode-highlight-text.rules', mergeConfig)
      nextTick(updateVStyle)
    })
  }))
  context.subscriptions.push(...disposes)
}

export function deactivate() {

}

function getUserConfigurationStyle(lan: string) {
  const config = getConfiguration('vscode-highlight-text.rules', defaultConfig)
  const k = Object.keys(config).findLast(key => key === lan || (key.includes('|') && key.split('|').includes(lan)))
  if (k)
    return config[k]
}
