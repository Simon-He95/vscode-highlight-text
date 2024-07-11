import { addEventListener, createExtension, createRange, createSelect, createStyle, getActiveText, getActiveTextEditorLanguageId, getConfiguration, getCurrentFileUrl, getPosition, isDark, message, nextTick, registerCommand, setConfiguration, setStyle } from '@vscode-use/utils'
import { debounce, deepMerge, isArray, isObject } from 'lazy-js-utils'
import { createFilter } from '@rollup/pluginutils'
import type { TextEditorDecorationType } from 'vscode'
import templates from './template'
import type { ClearStyle, UserConfig } from './type'
import { safeMatchAll, safeReplace } from './utils'

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
const clearStyle: ClearStyle = {}
function getUserConfigurationStyle(lan: string) {
  const config = getConfiguration('vscode-highlight-text.rules', defaultConfig)
  const k = Object.keys(config).findLast(key => key === lan || (key.includes('|') && key.split('|').includes(lan)))
  if (k)
    return config[k]
}

export const { activate, deactivate } = createExtension(() => {
  // 切换激活文本时检测整个文本，后续只针对更新内容
  const getLan = () => {
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
    return lan
  }

  const updateVStyle = debounce(() => {
    const defaultExclude = getConfiguration('vscode-highlight-text.exclude')
    const filter = createFilter(defaultExclude)
    const currentFileUrl = getCurrentFileUrl(true)
    const stacks: (() => void)[] = []
    if (!currentFileUrl)
      return
    if (filter(currentFileUrl.path))
      return
    const lan = getLan()
    if (!lan)
      return

    // 支持 key 为 'a|b' 的形式
    const userConfigurationStyle = getUserConfigurationStyle(lan)?.[isDark() ? 'dark' : 'light']
    if (!userConfigurationStyle)
      return

    const cacheKey = currentFileUrl.fsPath + currentFileUrl.scheme
    const cache = clearStyle[cacheKey]

    const run = (matchText: string, matcher: RegExpExecArray, style: TextEditorDecorationType) => {
      const start = matcher.index! + matcher[0].indexOf(matchText)
      const end = start + (matchText.length)
      const range = createRange(getPosition(start), getPosition(end))
      // 如果 cache 中存在一样的缓存就不再设置，也从要还原的缓存中拿走该项
      const positionKey: string = [range.start.line, range.start.character, range.end.line, range.end.character].join('-')
      if (clearStyle[cacheKey].has(positionKey)) {
        const clear = clearStyle[cacheKey].get(positionKey)!
        clearStyle[cacheKey].delete(positionKey)
        stacks.push(() => clearStyle[cacheKey].set(positionKey, clear))
      }
      else {
        const clear = setStyle(style, range)!
        stacks.push(() => clearStyle[cacheKey].set(positionKey, clear))
      }
    }

    if (!cache)
      clearStyle[cacheKey] = new Map()

    let text = getActiveText()!

    if (!text)
      return

    for (const color in userConfigurationStyle) {
      let option = userConfigurationStyle[color] as (string | [string, string])[] | UserConfig
      let styleOption: any = { color, isWholeLine: false }
      if (!Array.isArray(option) && option.match) {
        styleOption = Object.assign({ color }, option, { after: option.after }, { before: option.before }) as any
        option = option.match
      }
      const style = createStyle(styleOption)
      if (Array.isArray(option) && option.length) {
        option.forEach((o) => {
          const reg = isArray(o)
            ? new RegExp(o[0], o[1] || 'gm')
            : new RegExp(o, 'gm')

          // 如果有 colors 字段
          const colors = styleOption.colors
          const matchCss = styleOption.matchCss
          const ignoreReg = styleOption.ignoreReg

          if (ignoreReg?.length) {
            for (const regStr of ignoreReg.filter(Boolean)) {
              const reg = isArray(regStr)
                ? new RegExp(regStr[0], regStr[1])
                : new RegExp(regStr, 'g')
              text = safeReplace(text, reg, (_: string) => ' '.repeat(_.length), 1000)
            }
          }
          for (const matcher of safeMatchAll(text, reg)) {
            if (isArray(matchCss)) {
              for (let i = 0; i < matchCss.length; i++) {
                const option = matchCss[i]
                if (!option)
                  break
                if (!isObject(option))
                  return message.error('matchCss 类型错误')
                const matchText = matcher[i + 1]
                if (matchText === undefined)
                  break
                if (!matchText)
                  continue
                const style = createStyle(Object.assign({ color, isWholeLine: false }, option))
                run(matchText, matcher, style)
              }
            }
            else if (isArray(colors)) {
              for (let i = 0; i < colors.length; i++) {
                const c = colors[i]
                if (!c)
                  continue
                const matchText = matcher[i + 1]
                if (matchText === undefined)
                  break
                if (!matchText)
                  continue

                const style = createStyle({ color: c, isWholeLine: false })
                run(matchText, matcher, style)
              }
            }
            else if (!colors) {
              let matchText
              // 忽略 undefined 的 match 项
              if (matcher.length > 1) {
                for (let i = 1; i < matcher.length; i++) {
                  matchText = matcher[i]
                  if (matchText !== undefined)
                    break
                }
              }
              else { matchText = matcher[0] }
              if (!matchText)
                continue
              run(matchText, matcher, style)
            }
            else if (colors && !isArray(colors)) {
              return message.error(`colors 字段类型错误，需要是 colorsArray`)
            }
            else if (matchCss && !isArray(matchCss)) {
              return message.error(`matchCss 字段类型错误，需要是 styleArray`)
            }
          }
        })
      }
    }
    // 将剩余 clearStyle 中 cache 清楚，再增加 stacks 中需要新增的
    clearStyle[cacheKey].forEach((clear) => {
      clear()
    })
    clearStyle[cacheKey].clear()
    stacks.forEach(add => add())
  }, 100)

  updateVStyle()

  return [
    addEventListener('text-change', updateVStyle),
    addEventListener('activeText-change', (e) => {
      if (e)
        updateVStyle()
    }),
    addEventListener('config-change', updateVStyle),
    addEventListener('theme-change', updateVStyle),
    registerCommand('vscode-highlight-text.selectTemplate', () => {
      const options = Object.keys(templates)
      if (!options.length)
        return
      createSelect(options).then((select: any) => {
        if (!select)
          return
        const templateConfig = (templates as any)[select]
        const userConfig = getConfiguration('vscode-highlight-text.rules')
        // 把用户的 config 和 模板的 config 合并
        const mergeConfig = deepMerge(userConfig, templateConfig)
        setConfiguration('vscode-highlight-text.rules', mergeConfig)
        nextTick(updateVStyle)
      })
    }),
  ]
}, () => {
  Object.keys(clearStyle).forEach((key) => {
    clearStyle[key].clear()
  })
})
