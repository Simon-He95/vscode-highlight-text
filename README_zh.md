<p align="center">
<img height="200" src="./icon.png" alt="vscode-highlight-text">
</p>
<p align="center"> <a href="./README.md">English</a> | 简体中文</p>

自定义配置任意语言的高亮语法，比如 vue、react、svelte、solid 等，你可以强调突出一些特定的语法或者事件，让你更加容易阅读代码也可以让你的编辑器看上去更与众不同，如果你觉得你搭配的风格很炫酷,欢迎提 pr，可以作为内置的模板风格选择提供给更多人使用。

![demo](/assets/demo.jpg)

## Configuration
```typescript
  // 自定义设置高亮样式
        "vscode-highlight-text.rules": {
          "type": "object",
          "default": {
            "vue": {
              "light": {
                "purple": {
                  "match": [
                    "v-if",
                    "v-else-if",
                    "v-else"
                  ],
                  "before": {
                    "contentText": "✨"
                  }
                },
                "#B392F0": [
                  "v-for"
                ],
                "#FFC83D": [
                  "<template\\s+(\\#[^\\s\\/>=]+)",
                  "v-bind",
                  "v-once",
                  "v-on",
                  "(v-slot:[^>\\s\\/>]+)",
                  "v-html",
                  "v-text"
                ],
                "rgb(99, 102, 241)": [
                  ":is"
                ],
                "rgb(14, 165, 233)": [
                  "(defineProps)[<\\(]",
                  "defineOptions",
                  "defineEmits",
                  "defineExpose"
                ]
              },
              "dark": {
                "purple": {
                  "match": [
                    "v-if",
                    "v-else-if",
                    "v-else"
                  ],
                  "before": {
                    "contentText": "✨"
                  }
                },
                "#B392F0": [
                  "v-for"
                ],
                "#FFC83D": [
                  "<template\\s+(\\#[^\\s\\/>=]+)",
                  "v-bind",
                  "v-once",
                  "v-on",
                  "(v-slot:[^>\\s\\/>]+)",
                  "v-html",
                  "v-text"
                ],
                "rgb(99, 102, 241)": {
                  "match": [
                    ":is"
                  ]
                },
                "rgb(14, 165, 233)": [
                  "(defineProps)[<\\(]",
                  "defineOptions",
                  "defineEmits",
                  "defineExpose"
                ]
              }
            },
            "react": {
              "light": {},
              "dark": {}
            }
          },
          "description": "highlight vue | react | svelte | solid | astro | ... style"
        }
```

## Feature

### 1. 你可以在同一个配置下作用于多个类型文件通过 `|` 分隔, 下面的例子就是 `react、typescript、javascript` 共同的配置

```json
{
  "react|typescript|javascript": {
    "light": {},
    "dark": {}
  }
}
```

### 2. 你可以在一个正则中，对多个 match 项设置不同的style

 - 例子 1:

  ```md
  "match": ["(function)\\s+([\\w]*)"], 这个正则匹配到了 `match1: function` 和 `match2: functionName`
  "colors": ["red", "yellow"], 这个 colors 可以将 match1 设置为 red，将 match2 设置为 yellow
  ```
  > 例子 1 只是对颜色的便捷使用，如果要更多属性可以参考例子 2

 - 例子 2:

 ```md
  "match": ["(function)\\s+([\\w]*)"], 这个正则匹配到了 `match1: function` 和 `match2: functionName`
  "matchCss": [{
    "color": "red",
    "before": {
      "contentText": "✨"
    }
  },{
    "color": "yellow"
  }]
  ```

## Show your style

- 你可以在[这里](https://github.com/Simon-He95/vscode-highlight-text/issues/5)去分享你觉得很炫酷的风格,也可以提 pr 作为内置的模板风格选择提供给更多人使用.

## :coffee:

[请我喝一杯咖啡](https://github.com/Simon-He95/sponsor)

## License

[MIT](./license)

## Sponsors

<p align="center">
  <a href="https://cdn.jsdelivr.net/gh/Simon-He95/sponsor/sponsors.svg">
    <img src="https://cdn.jsdelivr.net/gh/Simon-He95/sponsor/sponsors.png"/>
  </a>
</p>
