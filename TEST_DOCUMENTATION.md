# VSCode Highlight Text - 测试用例文档

## 🧪 测试覆盖总览

我们为VSCode高亮插件创建了全面的测试套件，覆盖以下几个关键方面：

### ✅ 已实现的测试模块

#### 1. **核心功能测试** (`utils-standalone.test.ts`) - 21个测试
- **safeMatchAll函数测试**
  - Vue指令匹配 (v-if, v-else, v-for)
  - React Hook匹配 (useState, useEffect, useContext)
  - 复杂Vue模板模式 (template slots, v-slot)
  - 无限循环防护
  - 零宽度匹配处理
  - 错误处理 (非全局正则)

- **safeReplace函数测试**
  - Vue指令安全替换
  - React Hook安全替换
  - 复杂替换逻辑
  - 无限替换循环防护

- **性能测试**
  - 大文本处理 (10K+ 匹配)
  - 复杂模式处理
  - 执行时间监控

- **边界情况测试**
  - 特殊字符处理
  - 多行文本
  - Unicode字符支持

#### 2. **正则安全测试** (`regex-safety.test.ts`) - 21个测试
- **危险模式检测**
  - 嵌套量词 `(a*)+`, `(a+)*`
  - 大范围量词 `a{10,}*`
  - 负向断言 `(?!)`, `(?<!)`
  - 超长字符类

- **安全模式验证**
  - 简单字面量模式
  - 单词边界 `\b`
  - 合理字符类
  - 捕获组

- **真实世界模式测试**
  - Vue指令模式验证
  - React Hook模式验证
  - 模板语法模式

#### 3. **集成测试** (`integration.test.ts`) - 17个测试
- **Vue文件处理**
  - SFC (Single File Component) 处理
  - TypeScript支持
  - 指令识别

- **React文件处理**
  - Hook模式识别
  - 自定义Hook支持
  - JSX语法

- **混合内容处理**
  - Vue + React风格模式
  - 多语言文件支持

- **配置测试**
  - 空配置处理
  - 错误配置恢复
  - 文件大小限制

- **错误恢复**
  - 编辑器不可用
  - 文档读取错误
  - 快速文件切换

## 📊 测试统计

| 测试类别 | 测试数量 | 通过率 | 状态 |
|---------|---------|--------|------|
| 核心功能 | 21 | 100% | ✅ |
| 正则安全 | 21 | 100% | ✅ |
| 集成测试 | 17 | 100% | ✅ |
| **总计** | **59** | **100%** | ✅ |

## 🔧 测试配置

### 测试脚本
```json
{
  "test": "vitest run --reporter=verbose",
  "test:watch": "vitest --watch",
  "test:coverage": "vitest run --coverage"
}
```

### 使用方法
```bash
# 运行所有测试
npm test

# 监听模式运行测试
npm run test:watch

# 生成测试覆盖率报告
npm run test:coverage
```

### 测试环境
- **框架**: Vitest
- **模拟**: VSCode API Mock
- **覆盖率**: C8 Provider
- **超时**: 30秒 (性能测试)

## 🎯 测试重点

### 1. **内存安全**
- 缓存大小限制测试
- 内存泄漏防护验证
- 自动清理机制测试

### 2. **性能保护**
- 大文件处理限制
- 正则执行超时
- 复杂模式处理

### 3. **正则安全**
- 回溯过多检测
- 危险模式识别
- 安全模式验证

### 4. **错误处理**
- 优雅降级测试
- 异常恢复验证
- 用户友好错误

## 🚀 测试覆盖的真实场景

### Vue开发场景
```vue
<template>
  <div v-if="show" v-for="item in items">
    <span v-text="item.name"></span>
    <template #header>
      <h1>{{ title }}</h1>
    </template>
  </div>
</template>
```

### React开发场景
```tsx
function Component() {
  const [count, setCount] = useState(0)
  useEffect(() => {}, [])
  const custom = useCustomHook()
  return <div>{count}</div>
}
```

### 边界测试场景
```javascript
// 大文件测试
const largeContent = 'v-if '.repeat(10000) // ~50KB

// Unicode支持
const unicode = 'Hello 世界 v-if测试'

// 复杂嵌套
const complex = '<template #header><div v-slot:footer></div></template>'
```

## 📈 性能基准

| 测试场景 | 文本大小 | 执行时间 | 内存使用 |
|---------|---------|---------|---------|
| 小文件 | < 1KB | < 10ms | 最小 |
| 中等文件 | 1-100KB | < 100ms | 适中 |
| 大文件 | 100-500KB | < 1000ms | 受限 |
| 超大文件 | > 500KB | 跳过处理 | 保护 |

## 🛡️ 安全保障

### 正则安全级别
- ✅ **Level 1**: 基础模式 (字面量匹配)
- ✅ **Level 2**: 简单量词 (`*`, `+`, `?`)
- ✅ **Level 3**: 字符类 (`[a-z]`, `[^abc]`)
- ✅ **Level 4**: 捕获组 `(pattern)`
- ❌ **Level 5**: 复杂断言 (被拒绝)
- ❌ **Level 6**: 嵌套量词 (被拒绝)

### 内存保护
- 缓存文件数限制: 50个
- 单文件大小限制: 500KB
- 正则匹配数限制: 10,000个
- 执行时间限制: 5秒

## 🎉 总结

我们的测试套件提供了：

1. **全面覆盖**: 59个测试用例覆盖所有核心功能
2. **安全保障**: 多层级的安全检测和保护机制
3. **性能优化**: 针对各种场景的性能测试和优化
4. **真实场景**: 基于实际开发中的使用模式
5. **持续集成**: 易于集成到CI/CD流程

这个测试套件确保了VSCode高亮插件在各种条件下都能稳定、安全、高效地运行！
