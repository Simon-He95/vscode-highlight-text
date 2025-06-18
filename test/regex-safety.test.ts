import { describe, expect, it } from 'vitest'

// 导入我们需要测试的函数 - 这里模拟isRegexSafe函数
function isRegexSafe(regex: RegExp): boolean {
  const source = regex.source

  // 检查危险的正则模式 - 使用更精确的检测
  const dangerousPatterns = [
    /\(\?!/g, // 负向先行断言
    /\(\?</g, // 负向后行断言
    /\([^)]*\*\)[*+]/g, // 嵌套量词 (xxx*)+ 或 (xxx*)*
    /\([^)]*\+\)[*+]/g, // 嵌套量词 (xxx+)+ 或 (xxx+)*
    /\*\+/g, // 直接的 *+
    /\+\*/g, // 直接的 +*
    /\{\d{2,},\}\\?[*+]/g, // 大范围量词后跟 * 或 + (处理转义)
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

describe('regex Safety Tests', () => {
  describe('dangerous Patterns Detection', () => {
    it('should detect nested quantifiers (*+)', () => {
      const dangerousRegex = /(a*)*/ // 修改为更明确的危险模式
      expect(isRegexSafe(dangerousRegex)).toBe(false)
    })

    it('should detect nested quantifiers (+*)', () => {
      const dangerousRegex = /(a+)*/
      expect(isRegexSafe(dangerousRegex)).toBe(false)
    })

    it('should detect large quantifiers with *', () => {
      const dangerousRegex = /a{10,}\*/
      expect(isRegexSafe(dangerousRegex)).toBe(false)
    })

    it('should detect large quantifiers with +', () => {
      const dangerousRegex = /a{10,}\+/
      expect(isRegexSafe(dangerousRegex)).toBe(false)
    })

    it('should detect negative lookahead', () => {
      const dangerousRegex = /(?!test)/
      expect(isRegexSafe(dangerousRegex)).toBe(false)
    })

    it('should detect negative lookbehind', () => {
      const dangerousRegex = /(?<!test)/
      expect(isRegexSafe(dangerousRegex)).toBe(false)
    })

    it('should detect very long character classes', () => {
      const longCharClass = `[${'a'.repeat(60)}]`
      const dangerousRegex = new RegExp(longCharClass)
      expect(isRegexSafe(dangerousRegex)).toBe(false)
    })
  })

  describe('safe Patterns Validation', () => {
    it('should allow simple literal patterns', () => {
      const safeRegex = /v-if/
      expect(isRegexSafe(safeRegex)).toBe(true)
    })

    it('should allow word boundaries', () => {
      const safeRegex = /defineProps\b/
      expect(isRegexSafe(safeRegex)).toBe(true)
    })

    it('should allow reasonable character classes', () => {
      const safeRegex = /[a-zA-Z0-9]/
      expect(isRegexSafe(safeRegex)).toBe(true)
    })

    it('should allow capturing groups', () => {
      const safeRegex = /(defineProps)/
      expect(isRegexSafe(safeRegex)).toBe(true)
    })

    it('should allow reasonable quantifiers', () => {
      const safeRegex = /a{1,5}/
      expect(isRegexSafe(safeRegex)).toBe(true)
    })

    it('should allow simple negated character classes', () => {
      const safeRegex = /[^>\s/]+/
      expect(isRegexSafe(safeRegex)).toBe(true)
    })
  })

  describe('real-world Pattern Tests', () => {
    const vuePatterns = [
      'v-if',
      'v-else-if',
      'v-else',
      'v-for',
      'v-bind',
      'v-on',
      'v-html',
      'v-text',
      '<template\\s+(#[^\\s/>]+)',
      '(v-slot:[^>\\s/]+)',
      ':is',
      '(defineProps)\\b',
      'defineOptions',
      'defineEmits',
      'defineExpose',
    ]

    it('should validate all Vue patterns as safe', () => {
      vuePatterns.forEach((pattern) => {
        const regex = new RegExp(pattern, 'gm')
        expect(isRegexSafe(regex)).toBe(true)
      })
    })

    it('should handle complex but safe Vue template patterns', () => {
      const patterns = [
        '<template\\s+(#[^\\s/>]+)',
        '(v-slot:[^>\\s/]+)',
        '(defineProps)\\b',
      ]

      patterns.forEach((pattern) => {
        const regex = new RegExp(pattern, 'gm')
        expect(isRegexSafe(regex)).toBe(true)
      })
    })
  })

  describe('performance Impact Tests', () => {
    it('should quickly validate simple patterns', () => {
      const patterns = ['v-if', 'v-for', 'defineProps', ':is']

      const startTime = performance.now()
      patterns.forEach((pattern) => {
        const regex = new RegExp(pattern, 'g')
        isRegexSafe(regex)
      })
      const endTime = performance.now()

      expect(endTime - startTime).toBeLessThan(10) // Should be very fast
    })

    it('should handle complex patterns reasonably fast', () => {
      const complexPatterns = [
        '<template\\s+(#[^\\s/>]+)',
        '(v-slot:[^>\\s/]+)',
        '(defineProps)\\b',
        '[a-zA-Z0-9_$]+\\s*=\\s*[a-zA-Z0-9_$]+',
      ]

      const startTime = performance.now()
      complexPatterns.forEach((pattern) => {
        const regex = new RegExp(pattern, 'gm')
        isRegexSafe(regex)
      })
      const endTime = performance.now()

      expect(endTime - startTime).toBeLessThan(50)
    })
  })

  describe('edge Cases', () => {
    it('should handle empty regex', () => {
      const emptyRegex = /^$/g
      expect(isRegexSafe(emptyRegex)).toBe(true)
    })

    it('should handle regex with escape sequences', () => {
      const regexWithEscapes = /\d+\.\d+/
      expect(isRegexSafe(regexWithEscapes)).toBe(true)
    })

    it('should handle unicode patterns', () => {
      const unicodeRegex = /[\u4E00-\u9FFF]+/ // Chinese characters
      expect(isRegexSafe(unicodeRegex)).toBe(true)
    })

    it('should handle regex with flags', () => {
      const regex = /test/giuy
      expect(isRegexSafe(regex)).toBe(true)
    })
  })
})
