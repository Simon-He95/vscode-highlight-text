自定义配置任意语言的高亮语法，比如 vue、react、svelte、solid 等，你可以强调突出一些特定的语法或者事件，如果你觉得你搭配的风格很炫酷欢迎提 pr，可以作为内置的模板风格选择提供给更多人使用

![demo](/assets/demo.jpg)

## Configuration
```typescript
  // 自定义设置高亮样式
        "vscode-highlight.rules": {
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
