强调突出 vue 中的 `v-if`、`v-else-if`、`v-else`...,因为它很重要，我希望特别强调突出它,也可以自定义配置希望强调突出的属性。

![demo](/assets/demo.jpg)

## Configuration
```typescript
  // 自定义设置高亮样式
        "vscode-vue-highlight.rules": {
          "type": "object",
          "default": {
            "light": {
              "rgb(248 113 113)": [
                "v-if",
                "v-else-if",
                "v-else"
              ],
              "#B392F0": [
                "v-for"
              ],
              "#FFC83D": {
                match: [
                "v-bind"
                ],
                ...customStyle // 自定义style，比如backgroundColor
              }
            },
            "dark": {
              "rgb(248 113 113)": [
                "v-if",
                "v-else-if",
                "v-else"
              ],
              "#B392F0": [
                "v-for"
              ],
              "#FFC83D": {
                "match": [
                  "v-bind"
                ],
                "backgroundColor": "red"
              }
            }
          },
          "description": "v- highlight style"
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
