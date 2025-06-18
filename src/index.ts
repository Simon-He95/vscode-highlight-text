import type { DecorationRenderOptions, Range } from 'vscode'
import type { ClearStyle, UserConfig } from './type'
import { createFilter } from '@rollup/pluginutils'
import { addEventListener, createExtension, createRange, createSelect, createStyle, getActiveText, getActiveTextEditor, getActiveTextEditorLanguageId, getConfiguration, getCurrentFileUrl, getPosition, isDark, message, registerCommand, setConfiguration, setStyle } from '@vscode-use/utils'
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
const MAX_CACHE_SIZE = 50 // 限制缓存文件数量，防止内存泄漏
const MAX_TEXT_SIZE = 500000 // 限制处理的文本大小，防止性能问题
const REGEX_CACHE = new Map<string, RegExp>() // 正则表达式缓存
const MAX_REGEX_CACHE_SIZE = 200 // 限制正则缓存大小
let config = getConfiguration('vscode-highlight-text.rules', defaultConfig)

// 缓存正则表达式，避免重复编译
function getCachedRegex(pattern: string, flags: string = 'gm'): RegExp {
  const key = `${pattern}::${flags}`

  if (REGEX_CACHE.has(key)) {
    const cached = REGEX_CACHE.get(key)!
    // 重置lastIndex，防止状态污染
    cached.lastIndex = 0
    return cached
  }

  // 清理缓存，防止内存泄漏
  if (REGEX_CACHE.size >= MAX_REGEX_CACHE_SIZE) {
    const firstKey = REGEX_CACHE.keys().next().value
    if (firstKey) {
      REGEX_CACHE.delete(firstKey)
    }
  }

  try {
    const regex = new RegExp(pattern, flags)
    REGEX_CACHE.set(key, regex)
    return regex
  }
  catch (error) {
    message.error(`Invalid regex pattern: ${pattern}`)
    throw error
  }
}

// 检查正则表达式是否安全，防止回溯过多
function isRegexSafe(regex: RegExp): boolean {
  const source = regex.source
  // 检查危险的正则模式
  const dangerousPatterns = [
    /\(\?!/g, // 负向先行断言
    /\(\?</g, // 负向后行断言
    /\*\+/g, // 嵌套量词 *+
    /\+\*/g, // 嵌套量词 +*
    /\{\d+,\}\*/g, // 大范围量词后跟 *
    /\{\d+,\}\+/g, // 大范围量词后跟 +
  ]

  for (const pattern of dangerousPatterns) {
    if (pattern.test(source)) {
      return false
    }
  }

  // 检查字符类的复杂度
  const charClassMatches = source.match(/\[[^\]]*\]/g)
  if (charClassMatches) {
    for (const charClass of charClassMatches) {
      if (charClass.length > 50) { // 字符类过长
        return false
      }
    }
  }

  return true
}

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
    // 性能监控
    const startTime = performance.now()

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

    // 清理缓存，防止内存泄漏
    if (Object.keys(clearStyle).length > MAX_CACHE_SIZE) {
      const cacheKeys = Object.keys(clearStyle)
      const excessCount = cacheKeys.length - MAX_CACHE_SIZE + 10 // 一次性清理多个，减少频繁清理
      for (let i = 0; i < excessCount; i++) {
        const oldestKey = cacheKeys[i]
        if (clearStyle[oldestKey]) {
          clearStyle[oldestKey].forEach(clear => clear())
          clearStyle[oldestKey].clear()
          delete clearStyle[oldestKey]
        }
      }
    }

    // 支持 key 为 'a|b' 的形式
    const userConfigurationStyles = getUserConfigurationStyle(lan, isDark() ? 'dark' : 'light')
    if (!userConfigurationStyles.length)
      return

    const cacheKey = currentFileUrl.fsPath + currentFileUrl.scheme
    const cache = clearStyle[cacheKey]

    if (refresh) {
      // 清除所有缓存并强制重新计算
      Object.keys(clearStyle).forEach((key) => {
        Array.from(clearStyle[key].values()).forEach(c => c())
        clearStyle[key].clear()
      })
    }
    else {
      // 删除其他文件的缓存，保留当前文件
      Object.keys(clearStyle).forEach((key) => {
        if (key !== cacheKey) {
          Array.from(clearStyle[key].values()).forEach(c => c())
          clearStyle[key].clear()
        }
      })
    }

    if (!cache)
      clearStyle[cacheKey] = new Map()

    // Get full text
    const fullText = getActiveText()!
    if (!fullText) {
      clearStyle[cacheKey]?.forEach((clear, key) => {
        clear()
        clearStyle[cacheKey].delete(key)
      })
      return
    }

    // 检查文本大小，防止性能问题
    if (fullText.length > MAX_TEXT_SIZE) {
      message.warn(`File too large (${fullText.length} characters), highlighting disabled for performance reasons`)
      return
    }

    // Get visible range from active editor
    const editor = getActiveTextEditor()
    if (!editor)
      return

    // Calculate visible range
    const visibleRange = getVisibleRange(editor.visibleRanges)
    if (!visibleRange)
      return

    // Convert range to string indices
    const startPosition = visibleRange.start
    const endPosition = visibleRange.end
    const visibleText = editor.document.getText(createRange(startPosition, endPosition))

    // Process only the visible text
    let text = visibleText
    const visibleStartOffset = editor.document.offsetAt(startPosition)

    // Run function with offset adjustment
    const runWithOffset = (matchText: string, matcher: RegExpExecArray, styleOption: DecorationRenderOptions) => {
      const style = createStyle(wrapperStyleForBackGround(styleOption))
      // 以免之前的匹配干扰
      let textSegment = matcher[0]
      for (let index = 1; index < matcher.length; index++) {
        const matchWord = matcher[index]
        if (!matchWord)
          continue

        if (matchWord === matchText)
          break

        textSegment = textSegment.replace(matchWord, '嘿'.repeat(matchWord.length))
      }

      // Add offset to match index to account for visible range
      const start = visibleStartOffset + matcher.index! + textSegment.indexOf(matchText)
      const end = start + (matchText.length)
      const range = createRange(getPosition(start).position, getPosition(end).position)

      // Check if range is valid before proceeding
      if (range.start.line < 0 || range.end.line < 0)
        return

      const rangeText = fullText.slice(start, end)
      const positionKey = createPositionKey(range, rangeText, styleOption)

      if (clearStyle[cacheKey] && clearStyle[cacheKey].has(positionKey)) {
        const clear = clearStyle[cacheKey].get(positionKey)!
        stacks.push(() => clearStyle[cacheKey]?.set(positionKey, clear))
        clearStyle[cacheKey].delete(positionKey)
      }
      else {
        stacks.push(() => clearStyle[cacheKey]?.set(positionKey, setStyle(style, range)!))
      }
    }

    // Process configuration styles for visible text only
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
            try {
              const reg = isArray(o)
                ? getCachedRegex(o[0], o[1] || 'gm')
                : getCachedRegex(o, 'gm')

              // 验证正则表达式安全性
              if (!isRegexSafe(reg)) {
                message.warn(`Potentially unsafe regex detected: ${reg.source}`)
                return
              }

              // 如果有 colors 字段
              const colors = styleOption.colors
              const matchCss = styleOption.matchCss
              const ignoreReg = styleOption.ignoreReg
              if (ignoreReg?.length) {
                for (const regStr of ignoreReg.filter(Boolean)) {
                  const regIgnore = isArray(regStr)
                    ? getCachedRegex(regStr[0], regStr[1])
                    : getCachedRegex(regStr, 'gm')
                  text = safeReplace(text, regIgnore, (_: string) => ' '.repeat(_.length), 1000)
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
                    runWithOffset(matchText, matcher, Object.assign({ ...baseOption }, option))
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

                    runWithOffset(matchText, matcher, { ...baseOption, color })
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
                  let textSegment = matcher[0]
                  for (let index = 1; index < matcher.length; index++) {
                    const matchWord = matcher[index]
                    if (matchWord === matchText) {
                      break
                    }
                    textSegment = textSegment.replace(matchWord, '嘿'.repeat(matchWord.length))
                  }
                  const start = visibleStartOffset + matcher.index! + textSegment.indexOf(matchText)
                  const end = start + matchText.length
                  const range = createRange(getPosition(start).position, getPosition(end).position)
                  const rangeText = fullText.slice(start, end)
                  const positionKey = createPositionKey(range, rangeText, styleOption)
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
            }
            catch (error) {
              message.error(`Error processing regex pattern: ${error}`)
              console.error('Regex error:', error)
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

    // 性能监控
    const endTime = performance.now()
    const executionTime = endTime - startTime
    if (executionTime > 100) { // 如果执行时间超过100ms，记录警告
      console.warn(`updateVStyle execution took ${executionTime.toFixed(2)}ms`)
    }
  }, 300)

  updateVStyle()

  return [
    addEventListener('text-change', ({ document, contentChanges }) => {
      const change = contentChanges.filter(item => item.rangeLength || item.text)
      if (document.languageId !== 'Log' && change.length)
        updateVStyle()
    }),
    addEventListener('activeText-change', (e) => {
      if (e) {
        // 使用 setTimeout 确保文本完全加载后再处理
        setTimeout(() => {
          updateVStyle(true)
        }, 10)
      }
    }),
    addEventListener('config-change', (e) => {
      if (e.affectsConfiguration('vscode-highlight-text')) {
        config = getConfiguration('vscode-highlight-text.rules', defaultConfig)
      }
    }),
    addEventListener('theme-change', () => updateVStyle(true)),
    addEventListener('text-visible-change', (e) => {
      if (e)
        updateVStyle(false)
    }),
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
  // 彻底清理所有缓存，防止内存泄漏
  try {
    Object.keys(clearStyle).forEach((key) => {
      // 执行还原函数
      if (clearStyle[key]) {
        clearStyle[key].forEach((clear) => {
          try {
            clear()
          }
          catch (error) {
            console.error('Error clearing style:', error)
          }
        })
        clearStyle[key].clear()
        delete clearStyle[key]
      }
    })
    // 确保对象完全清空
    Object.keys(clearStyle).forEach(key => delete clearStyle[key])

    // 清理正则缓存
    REGEX_CACHE.clear()
  }
  catch (error) {
    console.error('Error during deactivation:', error)
  }
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

function getVisibleRange(visibleRanges: readonly Range[]) {
  if (!visibleRanges.length)
    return
  const range = visibleRanges[0]
  const start = range.start
  const lastRange = visibleRanges[visibleRanges.length - 1]
  const end = lastRange.end
  return {
    start,
    end,
  }
}

// 优化positionKey生成，避免重复JSON.stringify
function createPositionKey(range: Range, rangeText: string, styleOption: any): string {
  // 使用更高效的字符串拼接，避免JSON.stringify的性能开销
  const styleHash = typeof styleOption === 'object'
    ? Object.keys(styleOption).sort().map(k => `${k}:${styleOption[k]}`).join('|')
    : String(styleOption)

  return `${range.start.line},${range.start.character},${range.end.line},${range.end.character},${rangeText},${styleHash}`
}
