import type { DecorationRenderOptions } from 'vscode'
import type { ClearStyle, UserConfig } from './type'
import { createFilter } from '@rollup/pluginutils'
import { addEventListener, createExtension, createRange, createSelect, createStyle, getActiveText, getActiveTextEditorLanguageId, getConfiguration, getCurrentFileUrl, getPosition, isDark, message, registerCommand, setConfiguration, setStyle } from '@vscode-use/utils'
import { debounce, deepMerge, isArray, isObject } from 'lazy-js-utils'
import { DecorationRangeBehavior } from 'vscode'
import templates from './template'
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
let config = getConfiguration('vscode-highlight-text.rules', defaultConfig)

function getUserConfigurationStyle(lan: string, mode: 'dark' | 'light') {
  const keys = Object.keys(config).filter(key => isMatch(key, lan))
  const result = keys.reduceRight((r, k) => {
    const value = config[k][mode]
    r.push(value)
    return r
  }, [] as any).filter(Boolean)
  return result
}

function isMatch(a: string, b: string) {
  if (a === b)
    return true
  const aMap = a.split('|')
  const bMap = b.split('|')
  return aMap.some(i => bMap.includes(i)) || bMap.some(i => aMap.includes(i))
}

export const { activate, deactivate } = createExtension(() => {
  // 切换激活文本时检测整个文本，后续只针对更新内容
  const getLan = () => {
    let lan = getActiveTextEditorLanguageId()
    if (!lan)
      return

    switch (lan) {
      case 'vue':
        lan = /lang=['"]tsx['"]/.test(getActiveText()!) ? 'vuetsx|vue' : 'vue'
        break
      case 'javascriptreact':
      case 'typescriptreact':
        lan = 'react|javascriptreact|typescriptreact'
        break
      case 'svelte':
      case 'solid':
      case 'astro':
        break
      case 'plaintext':
        lan = 'txt|plaintext'
        break
      case 'markdown':
        lan = 'md|markdown'
        break
    }
    return lan
  }

  const updateVStyle = debounce((refresh: boolean) => {
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
    const userConfigurationStyles = getUserConfigurationStyle(lan, isDark() ? 'dark' : 'light')
    if (!userConfigurationStyles.length)
      return

    const cacheKey = currentFileUrl.fsPath + currentFileUrl.scheme
    const cache = clearStyle[cacheKey]

    if (refresh) {
      Object.keys(clearStyle).forEach((key) => {
        clearStyle[key].clear()
        delete clearStyle[key]
      })
    }
    else {
      // 删除其他文件的缓存
      Object.keys(clearStyle).forEach((key) => {
        if (key !== cacheKey) {
          clearStyle[key].clear()
          delete clearStyle[key]
        }
      })
    }

    if (!cache)
      clearStyle[cacheKey] = new Map()

    const run = (matchText: string, matcher: RegExpExecArray, styleOption: DecorationRenderOptions) => {
      const style = createStyle(wrapperStyleForBackGround(styleOption))
      // 以免之前的匹配干扰
      let text = matcher[0]
      for (let index = 1; index < matcher.length; index++) {
        const matchWord = matcher[index]
        if (!matchWord)
          continue

        if (matchWord === matchText)
          break

        text = text.replace(matchWord, '嘿'.repeat(matchWord.length))
      }

      const start = matcher.index! + text.indexOf(matchText)
      const end = start + (matchText.length)
      const range = createRange(getPosition(start).position, getPosition(end).position)
      // 如果 cache 中存在一样的缓存就不再设置，也从要还原的缓存中拿走该项
      const rangeText = getActiveText()!.slice(start, end)
      const positionKey: string = [range.start.line, range.start.character, range.end.line, range.end.character, rangeText, JSON.stringify(styleOption)].join('-')
      if (clearStyle[cacheKey] && clearStyle[cacheKey].has(positionKey)) {
        const clear = clearStyle[cacheKey].get(positionKey)!
        stacks.push(() => clearStyle[cacheKey]?.set(positionKey, clear))
        clearStyle[cacheKey].delete(positionKey)
      }
      else {
        stacks.push(() => clearStyle[cacheKey]?.set(positionKey, setStyle(style, range)!))
      }
    }

    // 获取当前光标位置的文本
    let text = getActiveText()!

    if (!text) {
      clearStyle[cacheKey]?.forEach((clear, key) => {
        clear()
        clearStyle[cacheKey].delete(key)
      })
      return
    }
    for (const userConfigurationStyle of userConfigurationStyles) {
      for (const color in userConfigurationStyle) {
        let option = userConfigurationStyle[color] as (string | [string, string])[] | UserConfig
        const baseOption: any = { color, isWholeLine: false, rangeBehavior: DecorationRangeBehavior.ClosedClosed }
        let styleOption: any = baseOption
        if (!Array.isArray(option) && option.match) {
          styleOption = Object.assign({ ...styleOption, color }, option, { after: option.after }, { before: option.before }) as any
          option = option.match
        }

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
                  : new RegExp(regStr, 'gm')
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
                  if (matchText === undefined && matcher[i + 2] === undefined)
                    break

                  if (!matchText)
                    continue
                  run(matchText, matcher, Object.assign({ ...baseOption }, option))
                }
              }
              else if (isArray(colors)) {
                for (let i = 0; i < colors.length; i++) {
                  const color = colors[i]
                  if (!color)
                    continue
                  const matchText = matcher[i + 1]
                  if (matchText === undefined && matcher[i + 2] === undefined)
                    break
                  if (!matchText)
                    continue

                  run(matchText, matcher, { ...baseOption, color })
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
                // 这里不能一个个设置，之前的样式会丢失
                // 以免之前的匹配干扰
                let text = matcher[0]
                for (let index = 1; index < matcher.length; index++) {
                  const matchWord = matcher[index]
                  if (matchWord === matchText) {
                    break
                  }
                  text = text.replace(matchWord, '嘿'.repeat(matchWord.length))
                }
                const start = matcher.index! + text.indexOf(matchText)
                const end = start + matchText.length
                const range = createRange(getPosition(start).position, getPosition(end).position)
                const rangeText = getActiveText()!.slice(start, end)
                const positionKey: string = [range.start.line, range.start.character, range.end.line, range.end.character, rangeText, JSON.stringify(styleOption)].join('-')
                const style = createStyle(wrapperStyleForBackGround(styleOption))
                if (clearStyle[cacheKey] && clearStyle[cacheKey].has(positionKey)) {
                  const clear = clearStyle[cacheKey].get(positionKey)!
                  stacks.push(() => clearStyle[cacheKey]?.set(positionKey, clear))
                  clearStyle[cacheKey].delete(positionKey)
                }
                else {
                  stacks.push(() => clearStyle[cacheKey]?.set(positionKey, setStyle(style, range)!))
                }
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
    }

    // 将剩余 clearStyle 中 cache 清除，再增加 stacks 中需要新增的
    clearStyle[cacheKey]?.forEach((clear, key) => {
      clear()
      clearStyle[cacheKey].delete(key)
    })
    stacks.forEach(add => add())
  }, 0)

  updateVStyle()

  return [
    addEventListener('text-change', ({ document, contentChanges }) => {
      const change = contentChanges.filter(item => item.rangeLength || item.text)
      if (document.languageId !== 'Log' && change.length)
        updateVStyle()
    }),
    addEventListener('activeText-change', (e) => {
      if (e)
        updateVStyle(true)
    }),
    addEventListener('config-change', (e) => {
      if (e.affectsConfiguration('vscode-highlight-text')) {
        config = getConfiguration('vscode-highlight-text.rules', defaultConfig)
        updateVStyle(true)
      }
    }),
    addEventListener('theme-change', () => updateVStyle(true)),
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
        setConfiguration('vscode-highlight-text.rules', mergeConfig).then(() => {
          updateVStyle(true)
        })
      })
    }),
  ]
}, () => {
  Object.keys(clearStyle).forEach((key) => {
    clearStyle[key].clear()
    delete clearStyle[key]
  })
})

function wrapperStyleForBackGround(styleOption: any) {
  if (styleOption.background) {
    if (!styleOption.textDecoration) {
      styleOption.textDecoration = `none; background:${styleOption.background}`
    }
    else {
      styleOption.textDecoration = `${styleOption.textDecoration}${styleOption.textDecoration.endsWith(';') ? '' : ';'} background:${styleOption.background}`
    }
  }
  return styleOption
}
