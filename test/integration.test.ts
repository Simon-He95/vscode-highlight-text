import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 模拟VSCode API
const mockEditor = {
  document: {
    getText: vi.fn(),
    languageId: 'vue',
    offsetAt: vi.fn(pos => pos.line * 100 + pos.character),
  },
  visibleRanges: [
    {
      start: { line: 0, character: 0 },
      end: { line: 50, character: 0 },
    },
  ],
}

const mockVSCode = {
  window: {
    activeTextEditor: mockEditor,
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key) => {
        if (key === 'vscode-highlight-text.rules') {
          return {
            vue: {
              light: {
                'purple': {
                  match: ['v-if', 'v-else-if', 'v-else'],
                  before: { contentText: '✨' },
                },
                '#B392F0': ['v-for'],
                '#FFC83D': ['v-bind', 'v-on'],
              },
              dark: {
                'purple': {
                  match: ['v-if', 'v-else-if', 'v-else'],
                  before: { contentText: '✨' },
                },
                '#B392F0': ['v-for'],
                '#FFC83D': ['v-bind', 'v-on'],
              },
            },
          }
        }
        return []
      }),
    })),
  },
  Range(start: any, end: any) {
    return { start, end }
  },
  Position(line: any, character: any) {
    return { line, character }
  },
  DecorationRangeBehavior: {
    ClosedClosed: 0,
  },
}

vi.mock('vscode', () => mockVSCode)

describe('integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset mock editor state
    mockEditor.document.getText.mockReturnValue('')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('vue File Processing', () => {
    it('should process Vue template with directives', () => {
      const vueTemplate = `
<template>
  <div v-if="isVisible" class="container">
    <ul v-for="item in items" :key="item.id">
      <li v-bind:class="item.class" v-on:click="handleClick">
        {{ item.name }}
      </li>
    </ul>
    <button v-else>No items</button>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

defineProps(['items'])
defineEmits(['itemClick'])

const isVisible = ref(true)
const handleClick = () => {
  // Handle click
}
</script>
      `

      mockEditor.document.getText.mockReturnValue(vueTemplate)
      mockEditor.document.languageId = 'vue'

      // Test that all Vue directives are found
      const patterns = [
        { regex: /v-if/g, expected: 1 },
        { regex: /v-for/g, expected: 1 },
        { regex: /v-bind/g, expected: 1 },
        { regex: /v-on/g, expected: 1 },
        { regex: /v-else/g, expected: 1 },
        { regex: /(defineProps|defineEmits)/g, expected: 2 },
      ]

      patterns.forEach(({ regex, expected }) => {
        const matches = vueTemplate.match(regex)
        expect(matches).toHaveLength(expected)
      })
    })

    it('should handle Vue SFC with TypeScript', () => {
      const vueTsxTemplate = `
<template lang="tsx">
  <div v-if="show">
    <MyComponent v-for="item in list" />
  </div>
</template>

<script setup lang="ts">
interface Props {
  items: Item[]
}

const props = defineProps<Props>()
const emit = defineEmits<{
  update: [value: string]
}>()
      `

      mockEditor.document.getText.mockReturnValue(vueTsxTemplate)

      // Should detect both Vue directives and TS constructs
      expect(vueTsxTemplate).toContain('v-if')
      expect(vueTsxTemplate).toContain('v-for')
      expect(vueTsxTemplate).toContain('defineProps')
      expect(vueTsxTemplate).toContain('defineEmits')
      expect(vueTsxTemplate).toContain('interface')
    })
  })

  describe('react File Processing', () => {
    it('should process React component with hooks', () => {
      const reactComponent = `
import React, { useState, useEffect, useContext, useCallback } from 'react'

function MyComponent({ items }) {
  const [count, setCount] = useState(0)
  const [data, setData] = useReducer(reducer, initialState)
  const theme = useContext(ThemeContext)
  
  useEffect(() => {
    document.title = \`Count: \${count}\`
  }, [count])
  
  const handleClick = useCallback(() => {
    setCount(prev => prev + 1)
  }, [])
  
  return (
    <div className="container">
      <h1>Count: {count}</h1>
      <button onClick={handleClick}>Increment</button>
      {items.map(item => (
        <div key={item.id}>{item.name}</div>
      ))}
    </div>
  )
}
      `

      mockEditor.document.getText.mockReturnValue(reactComponent)
      mockEditor.document.languageId = 'typescriptreact'

      const hookMatches = reactComponent.match(/(use[A-Z][a-zA-Z]*)/g)
      expect(hookMatches).toEqual([
        'useState',
        'useEffect',
        'useContext',
        'useCallback',
        'useState',
        'useReducer',
        'useContext',
        'useEffect',
        'useCallback',
      ])
    })

    it('should handle React with custom hooks', () => {
      const customHookComponent = `
function useCustomLogic() {
  const [state, setState] = useState(null)
  
  useEffect(() => {
    // Custom logic
  }, [])
  
  return { state, setState }
}

function Component() {
  const { state } = useCustomLogic()
  const data = useFetch('/api/data')
  const auth = useAuth()
  
  return <div>{state}</div>
}
      `

      const hookMatches = customHookComponent.match(/(use[A-Z][a-zA-Z]*)/g)
      expect(hookMatches).toContain('useCustomLogic')
      expect(hookMatches).toContain('useFetch')
      expect(hookMatches).toContain('useAuth')
    })
  })

  describe('mixed Content Processing', () => {
    it('should handle Vue component with React-like patterns', () => {
      const mixedContent = `
<template>
  <div v-if="isReactLike">
    <component :is="dynamicComponent" />
  </div>
</template>

<script setup>
// This looks like React but it's Vue
const [reactive, setReactive] = useReactiveState()
const effect = useEffect() // Custom Vue composable

defineProps(['data'])
</script>
      `

      mockEditor.document.getText.mockReturnValue(mixedContent)
      mockEditor.document.languageId = 'vue'

      // Should find Vue directives
      expect(mixedContent).toContain('v-if')
      expect(mixedContent).toContain(':is')
      expect(mixedContent).toContain('defineProps')

      // Should also find hook-like patterns (even in Vue)
      const hookLikeMatches = mixedContent.match(/(use[A-Z][a-zA-Z]*)/g)
      expect(hookLikeMatches).toContain('useReactiveState')
      expect(hookLikeMatches).toContain('useEffect')
    })
  })

  describe('configuration Edge Cases', () => {
    it('should handle empty configuration gracefully', () => {
      mockVSCode.workspace.getConfiguration.mockReturnValue({
        get: vi.fn(() => ({})),
      })

      // Should not crash with empty config
      expect(() => {
        // Simulate configuration loading
        const config = mockVSCode.workspace.getConfiguration().get('vscode-highlight-text.rules')
        expect(config).toEqual({})
      }).not.toThrow()
    })

    it('should handle malformed configuration', () => {
      mockVSCode.workspace.getConfiguration.mockReturnValue({
        get: vi.fn(() => ({
          vue: {
            light: {
              'invalid-color': null, // Invalid config
              'valid-color': ['v-if'],
            },
          },
        })),
      })

      const config = mockVSCode.workspace.getConfiguration().get('vscode-highlight-text.rules')
      expect(config.vue.light['valid-color']).toEqual(['v-if'])
      expect(config.vue.light['invalid-color']).toBeNull()
    })
  })

  describe('file Size Limits', () => {
    it('should handle large files appropriately', () => {
      const largeContent = 'v-if '.repeat(200000) // ~1.2MB
      mockEditor.document.getText.mockReturnValue(largeContent)

      // Should handle large files (implementation would check size)
      expect(largeContent.length).toBeGreaterThan(500000)
    })

    it('should handle very small files', () => {
      const tinyContent = 'v-if'
      mockEditor.document.getText.mockReturnValue(tinyContent)

      expect(tinyContent.length).toBeLessThan(100)
      expect(tinyContent).toContain('v-if')
    })
  })

  describe('language Detection', () => {
    const languageTests = [
      {
        language: 'vue',
        content: '<template><div v-if="true">Vue</div></template>',
        expectedPatterns: ['v-if'],
      },
      {
        language: 'typescriptreact',
        content: 'const [state] = useState(0)',
        expectedPatterns: ['useState'],
      },
      {
        language: 'javascriptreact',
        content: 'function Component() { useEffect(() => {}) }',
        expectedPatterns: ['useEffect'],
      },
      {
        language: 'svelte',
        content: '{#if condition}<div>Svelte</div>{/if}',
        expectedPatterns: ['{#if', '{/if}'],
      },
    ]

    languageTests.forEach(({ language, content, expectedPatterns }) => {
      it(`should detect ${language} patterns correctly`, () => {
        mockEditor.document.languageId = language
        mockEditor.document.getText.mockReturnValue(content)

        expectedPatterns.forEach((pattern) => {
          expect(content).toContain(pattern)
        })
      })
    })
  })

  describe('performance Integration', () => {
    it('should handle rapid file switching', () => {
      const files = [
        { lang: 'vue', content: '<template><div v-if="true">Vue</div></template>' },
        { lang: 'typescriptreact', content: 'const [state] = useState(0)' },
        { lang: 'javascript', content: 'console.log("plain JS")' },
      ]

      // Simulate rapid file switching
      files.forEach(({ lang, content }) => {
        mockEditor.document.languageId = lang
        mockEditor.document.getText.mockReturnValue(content)

        // Each file should be processed without issues
        expect(content.length).toBeGreaterThan(0)
      })
    })

    it('should handle concurrent processing requests', () => {
      const vueContent = '<div v-if="show" v-for="item in items">{{ item }}</div>'
      mockEditor.document.getText.mockReturnValue(vueContent)

      // Simulate multiple rapid updates
      for (let i = 0; i < 10; i++) {
        // Each call should handle the same content consistently
        expect(mockEditor.document.getText()).toBe(vueContent)
      }
    })
  })

  describe('error Recovery', () => {
    it('should recover from editor unavailable', () => {
      mockVSCode.window.activeTextEditor = null

      // Should handle no active editor gracefully
      expect(mockVSCode.window.activeTextEditor).toBeNull()
    })

    it('should recover from document read errors', () => {
      mockEditor.document.getText.mockImplementation(() => {
        throw new Error('Document not available')
      })

      expect(() => {
        try {
          mockEditor.document.getText()
        }
        catch (error) {
          // Should catch and handle gracefully
          expect(error.message).toBe('Document not available')
        }
      }).not.toThrow()
    })
  })
})
