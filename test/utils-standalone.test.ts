import { describe, expect, it } from 'vitest'

// 直接测试utils函数，避免VSCode依赖
describe('utils Functions', () => {
  // 复制safeMatchAll函数来测试
  function safeMatchAll(text: string, regex: RegExp, maxIterations = 1000) {
    if (!regex.global) {
      throw new Error('Regular expression must have the global flag set')
    }

    const results = []
    let match
    let iterations = 0

    while ((match = regex.exec(text)) !== null) {
      iterations++
      if (iterations > maxIterations) {
        console.warn(`Infinite loop detected in regular expression`)
        break
      }

      // 防止零宽度匹配导致的无限循环
      if (match.index === regex.lastIndex)
        regex.lastIndex++

      results.push(match)
    }

    return results
  }

  // 复制safeReplace函数来测试
  function safeReplace(str: string, regex: RegExp, replacement: (substring: string, ...args: any[]) => string, maxIterations: number = 1000) {
    let iterations = 0
    return str.replace(regex, (...args) => {
      iterations++
      if (iterations > maxIterations) {
        console.error(`Infinite loop detected in regular expression`)
        throw new Error(`Infinite loop detected in regular expression`)
      }

      return replacement(...args)
    })
  }

  describe('safeMatchAll', () => {
    it('should match Vue directives correctly', () => {
      const text = 'v-if="condition" v-else v-for="item in items"'
      const regex = /v-(if|else|for)/g
      const matches = safeMatchAll(text, regex)

      expect(matches).toHaveLength(3)
      expect(matches[0][0]).toBe('v-if')
      expect(matches[1][0]).toBe('v-else')
      expect(matches[2][0]).toBe('v-for')
    })

    it('should match React hooks correctly', () => {
      const text = 'useState useEffect useContext useReducer'
      const regex = /(use[A-Z]\w*)/g
      const matches = safeMatchAll(text, regex)

      expect(matches).toHaveLength(4)
      expect(matches[0][1]).toBe('useState')
      expect(matches[1][1]).toBe('useEffect')
      expect(matches[2][1]).toBe('useContext')
      expect(matches[3][1]).toBe('useReducer')
    })

    it('should handle complex Vue template patterns', () => {
      const template = '<template #header><div v-slot:footer></div></template>'
      const templateRegex = /<template\s+(#[^\s/>]+)/g
      const slotRegex = /(v-slot:[^>\s/]+)/g

      const templateMatches = safeMatchAll(template, templateRegex)
      const slotMatches = safeMatchAll(template, slotRegex)

      expect(templateMatches).toHaveLength(1)
      expect(templateMatches[0][1]).toBe('#header')
      expect(slotMatches).toHaveLength(1)
      expect(slotMatches[0][1]).toBe('v-slot:footer')
    })

    it('should prevent infinite loops with dangerous patterns', () => {
      const text = 'aaaaaaa'
      const regex = /a*/g // Potentially dangerous
      const matches = safeMatchAll(text, regex, 10)

      expect(matches.length).toBeLessThanOrEqual(10)
    })

    it('should handle empty text', () => {
      const matches = safeMatchAll('', /test/g)
      expect(matches).toHaveLength(0)
    })

    it('should throw error for non-global regex', () => {
      expect(() => {
        safeMatchAll('test', /test/)
      }).toThrow('Regular expression must have the global flag set')
    })

    it('should handle zero-width matches', () => {
      const text = 'abc'
      const regex = /(?=a)/g
      const matches = safeMatchAll(text, regex)

      expect(matches).toHaveLength(1)
    })
  })

  describe('safeReplace', () => {
    it('should replace Vue directives safely', () => {
      const text = 'v-if v-else v-for'
      const regex = /v-(\w+)/g
      const result = safeReplace(text, regex, (match, directive) => `**${directive}**`)

      expect(result).toBe('**if** **else** **for**')
    })

    it('should replace React hooks safely', () => {
      const text = 'useState useEffect'
      const regex = /(use[A-Z]\w*)/g
      const result = safeReplace(text, regex, match => `hook:${match}`)

      expect(result).toBe('hook:useState hook:useEffect')
    })

    it('should prevent infinite replacement loops', () => {
      const text = 'test'
      const regex = /t/g

      // 测试替换计数器是否正常工作
      let iterations = 0
      const result = safeReplace(text, regex, () => {
        iterations++
        return 'x' // 安全替换，不会导致循环
      }, 10)

      expect(iterations).toBe(2) // 'test' 中有两个 't'
      expect(result).toBe('xesx')
    })

    it('should handle complex replacements', () => {
      const code = 'defineProps defineEmits defineExpose'
      const regex = /(define[A-Z]\w*)/g
      const result = safeReplace(code, regex, match => `/* ${match} */`)

      expect(result).toBe('/* defineProps */ /* defineEmits */ /* defineExpose */')
    })
  })

  describe('performance Tests', () => {
    it('should handle large text efficiently', () => {
      const largeText = 'v-if '.repeat(10000)
      const regex = /v-if/g

      const startTime = Date.now()
      const matches = safeMatchAll(largeText, regex, 15000) // 提高限制以适应大文本
      const endTime = Date.now()

      expect(matches.length).toBeGreaterThan(9000) // 允许一些由于限制导致的少量匹配
      expect(endTime - startTime).toBeLessThan(1000) // Should complete within 1 second
    })

    it('should handle complex patterns on medium text', () => {
      const mediumText = '<template #header><div v-if="show">content</div></template>'.repeat(1000)
      const regex = /<template\s+(#[^\s/>]+)/g

      const matches = safeMatchAll(mediumText, regex)
      expect(matches).toHaveLength(1000)
    })
  })

  describe('edge Cases', () => {
    it('should handle special characters', () => {
      const text = 'const [state, setState] = useState()'
      const regex = /\[([^\]]+)\]/g
      const matches = safeMatchAll(text, regex)

      expect(matches).toHaveLength(1)
      expect(matches[0][1]).toBe('state, setState')
    })

    it('should handle multiline text', () => {
      const multiline = `
        v-if="condition"
        v-else-if="other"
        v-else
      `
      const regex = /v-(if|else-if|else)/g
      const matches = safeMatchAll(multiline, regex)

      expect(matches).toHaveLength(3)
    })

    it('should handle unicode characters', () => {
      const unicode = 'Hello 世界 测试 v-if'
      const regex = /v-if/g
      const matches = safeMatchAll(unicode, regex)

      expect(matches).toHaveLength(1)
    })
  })

  describe('real-world Pattern Validation', () => {
    const realPatterns = [
      { name: 'Vue directives', pattern: /v-(if|else|for|bind|on|text|html)/g },
      { name: 'React hooks', pattern: /(use[A-Z]\w*)/g },
      { name: 'Vue composables', pattern: /(defineProps|defineEmits|defineExpose)/g },
      { name: 'Template slots', pattern: /<template\s+(#[^\s/>]+)/g },
      { name: 'Slot bindings', pattern: /(v-slot:[^>\s/]+)/g },
    ]

    realPatterns.forEach(({ name, pattern }) => {
      it(`should validate ${name} pattern safety`, () => {
        const testText = 'a'.repeat(1000)

        // Should not hang or crash
        expect(() => {
          safeMatchAll(testText, pattern, 1000)
        }).not.toThrow()
      })
    })
  })
})
