import { addEventListener, createExtension, createRange, createSelect, createStyle, getActiveText, getActiveTextEditorLanguageId, getConfiguration, getCurrentFileUrl, getPosition, getSelection, isDark, message, nextTick, registerCommand, setConfiguration, setStyle } from '@vscode-use/utils'
import { debounce, deepMerge, isArray, isObject } from 'lazy-js-utils'
import { createFilter } from '@rollup/pluginutils'
import { DecorationRangeBehavior, type TextEditorDecorationType } from 'vscode'
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
function getUserConfigurationStyle(lan: string, mode: 'dark' | 'light') {
  const config = getConfiguration('vscode-highlight-text.rules', defaultConfig)
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

  const updateVStyle = debounce((isClear: boolean) => {
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

    const run = (matchText: string, matcher: RegExpExecArray, style: TextEditorDecorationType) => {
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
      const end = start + (matchText.length)
      const range = createRange(getPosition(start).position, getPosition(end).position)
      const { selection } = getSelection()!
      // 如果 cache 中存在一样的缓存就不再设置，也从要还原的缓存中拿走该项
      const positionKey: string = [range.start.line, range.start.character, range.end.line, range.end.character].join('-')
      if (clearStyle[cacheKey].has(positionKey)) {
        const clear = clearStyle[cacheKey].get(positionKey)!
        if (selection.active.line > range.start.line) {
          stacks.push(() => clearStyle[cacheKey].set(positionKey, clear))
          clearStyle[cacheKey].delete(positionKey)
        }
        else {
          clear()
          stacks.push(() => clearStyle[cacheKey].set(positionKey, setStyle(style, range)!))
        }
      }
      else {
        stacks.push(() => clearStyle[cacheKey].set(positionKey, setStyle(style, range)!))
      }
    }

    if (!cache)
      clearStyle[cacheKey] = new Map()

    // text 应该从 changed 背后截取，因为不会印象到之前的
    // 获取当前光标位置的文本
    let text = getActiveText()!
    const { selectionArray } = getSelection()!
    // 获取最前面一个selection
    let selection = selectionArray[0]
    if (!isClear) {
      const min: number[] = []
      if (selectionArray.length > 1) {
        // todo: 如果变更的内容不涉及换行，后面的内容也不需要被追加到更新 list 中
        selectionArray.forEach((item, i) => {
          if (!min.length) {
            min.push(item.start.line, item.start.character, i)
          }
          else {
            const [m1, m2] = min
            const c1 = item.start.line
            const c2 = item.start.character
            if (m1 < c1)
              return
            if (m1 === c1 && m2 < c2)
              return
            min[0] = c1
            min[1] = c2
            min[2] = i
          }
        })
        selection = selectionArray[min[2]]
      }
    }
    else {
      clearStyle[cacheKey].clear()
    }

    if (!text)
      return
    for (const userConfigurationStyle of userConfigurationStyles) {
      for (const color in userConfigurationStyle) {
        let option = userConfigurationStyle[color] as (string | [string, string])[] | UserConfig
        const baseOption: any = { color, isWholeLine: false, rangeBehavior: DecorationRangeBehavior.ClosedClosed }
        let styleOption: any = baseOption
        const ranges: any = []
        if (!Array.isArray(option) && option.match) {
          styleOption = Object.assign({ ...styleOption, color }, option, { after: option.after }, { before: option.before }) as any
          option = option.match
        }
        const style = createStyle(styleOption)
        const tempKeys: string[] = []
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
                  const style = createStyle(Object.assign({ ...baseOption }, option))
                  run(matchText, matcher, style)
                }
              }
              else if (isArray(colors)) {
                for (let i = 0; i < colors.length; i++) {
                  const color = colors[i]
                  if (!color)
                    continue
                  const matchText = matcher[i + 1]
                  if (matchText === undefined)
                    break
                  if (!matchText)
                    continue

                  const style = createStyle({ ...baseOption, color })
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
                const positionKey: string = [range.start.line, range.start.character, range.end.line, range.end.character].join('-')
                ranges.push(range)
                tempKeys.push(positionKey)
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
        const key = tempKeys.join('+')
        if (!key)
          continue
        if (clearStyle[cacheKey].has(key)) {
          const isUpdate = !tempKeys.every(k => +k.split('-')[0] < selection.active.line)
          if (isUpdate) {
            stacks.push(() => clearStyle[cacheKey].set(key, setStyle(style, ranges)!))
          }
          else {
            const clear = clearStyle[cacheKey].get(key)!
            stacks.push(() => clearStyle[cacheKey].set(key, clear))
            clearStyle[cacheKey].delete(key)
          }
        }
        else {
          stacks.push(() => clearStyle[cacheKey].set(key, setStyle(style, ranges)!))
        }
      }
    }

    // 将剩余 clearStyle 中 cache 清楚，再增加 stacks 中需要新增的
    clearStyle[cacheKey].forEach((clear) => {
      clear()
    })
    stacks.forEach(add => add())
  }, 100)

  updateVStyle(true)

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
      if (e.affectsConfiguration('vscode-highlight-text'))
        updateVStyle(true)
    }),
    addEventListener('theme-change', () => updateVStyle()),
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
        nextTick(() => updateVStyle(true))
      })
    }),
  ]
}, () => {
  Object.keys(clearStyle).forEach((key) => {
    clearStyle[key].clear()
  })
})
