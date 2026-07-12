<p align="center">
<img height="200" src="./icon.png" alt="vscode-highlight-text">
</p>
<p align="center"> <a href="./README.md">English</a> | 简体中文</p>

自定义配置任意语言的高亮语法，比如 vue、react、svelte、solid 等，你可以强调突出一些特定的语法或者事件，让你更加容易阅读代码也可以让你的编辑器看上去更与众不同，如果你觉得你搭配的风格很炫酷,欢迎提 pr，可以作为内置的模板风格选择提供给更多人使用。

![demo](/assets/demo.jpg)

## Configuration
> ⚠️ 请注意下面表示的是配置的类型, 如何配置可以参考 [shared rules](https://github.com/Simon-He95/vscode-highlight-text/issues/5)

```json
// 自定义设置高亮样式, 请注意下面表示的是配置的类型, 如何配置可以参考这个链接
{
  "vscode-highlight-text.rules": {
    "vue|react|typescript": {
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
          "\\s+(v-bind)",
          "\\s+(v-once)",
          "\\s+(v-on)",
          "\\s+(v-slot:[^>\\s\\/>]+)",
          "\\s+(v-html)",
          "\\s+(v-text)"
        ],
        "rgb(99, 102, 241)": [
          ":is"
        ],
        "rgb(110,231,183)": [
          "(defineProps)[<\\(]",
          "(defineOptions)[<\\(]",
          "(defineEmits)[<\\(]",
          "(defineExpose)[<\\(]"
        ]
      },
      "dark": {
        "#fae88e": {
          "match": [
            "^\\s*(?:export)?\\s*(type)\\s+",
            "^\\s*(?:export)?\\s*(interface)\\s+"
          ]
        },
        "#d798da": {
          "match": [
            "(?:=|^)\\s*(function) +(\\w*)"
          ],
          "colors": [
            "#d798da",
            "#c7fff9"
          ]
        },
        "#d9ceff": {
          "match": [
            [
              "^\\s*import\\s.*\\sfrom (['\"][^\\.~'\"][^\"']+['\"])",
              "gm"
            ]
          ]
        },
        "#c7fff9": {
          "match": [
            "^\\s*import\\s.*\\sfrom (['\"][\\.~\/][^\"']+['\"])"
          ]
        },
        "#cfe9c9": {
          "match": [
            "^\\s*import\\s+(['\"][^\"']+['\"])"
          ]
        },
        "purple": {
          "match": [
            "\\s(v-else-if)=",
            "\\s(v-if)=",
            "\\s(v-else)\\s"
          ],
          "before": {
            "contentText": "✨"
          }
        },
        "#B392F0": {
          "match": [
            "\\s+(v-for)="
          ]
        },
        "#FFC83D": [
          "<template\\s+(\\#[^\\s\\/>=]+)",
          "\\s+(v-bind)",
          "\\s+(v-once)",
          "\\s+(v-on)",
          "(v-slot:[^>\\s\\/>]+)",
          "\\s+(v-html)",
          "\\s+(v-text)"
        ],
        "rgb(99, 102, 241)": {
          "match": [
            ":is"
          ],
          "ignoreReg": [
            "`[^`]*`"
          ]
        },
        "#8589cf": [
          "(defineProps)[<\\(]",
          "(defineOptions)[<\\(]",
          "(defineEmits)[<\\(]",
          "(defineExpose)[<\\(]"
        ],
        "#174e3a": [
          "<(template)[^>]*>",
          "<\/(template)>"
        ],
        "#4d4c87": [
          "<(script)[^>]*>",
          "<\/(script)>"
        ],
        "#724485": [
          "<(style)[^>]*>",
          "<\/(style)>"
        ],
        "id": {
          "match": [
            "\\s+(id)="
          ],
          "before": {
            "contentText": "🆔"
          }
        },
        "key": {
          "match": [
            "\\s+(key)="
          ],
          "before": {
            "contentText": "🫧"
          }
        },
        "#f08b47": [
          "// TODO:.*"
        ],
        "#c41f0a": [
          "// IMPORTANT:.*"
        ],
        "#6c09ce": [
          "<script.*lang=\"(\\w+)\">"
        ],
        "#10b2ca": {
          "match": [
            "^\\s*//\\s*([0-9]+[.)、])"
          ]
        },
        "#1a5d70": {
          "match": [
            "^\\s*//[^\u4e00-\u9fa5\\n]*([\u4e00-\u9fa5,. ]+)[^\\n]*"
          ]
        },
        "#6d6d6d": {
          "match": [
            "(<!--[\\s\\S]*?-->)",
            "^\\s*(//[^\\n]*)"
          ]
        }
      }
    }
  }
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

### 3. 你可以使用 `ignoreReg` 去过滤不需要的内容
  ```md
   "match": ["(function)\\s+([\\w]*)"], this regular match matches `match1: function` and `match2: functionName`
   "ignoreReg": [
    "```([^`])+```" // 我不希望 match 的内容是在 ``` 和 ``` 之间的
   ]
   ```

### 4. 支持 RegExp 的 flags 传入
  ```md
   "red": [["[0-9]+", "gm"]]
   ```

## 性能与限制

为保持 VS Code Extension Host 响应流畅，高亮处理设有明确边界：单次可见扫描最多 200,000 个 UTF-16 单元、每条规则最多 1,000 个有效匹配、完整刷新最多保留 10,000 个 ranges、每个扫描分片最多 1,000ms、每个 worker 任务最多 500ms、失败规则冷却 30 秒、每个 profile 最多 1,000 个 layers、每个活动 manager 最多 1,500 个 decoration types。扫描时间预算耗尽后，会从下一条未处理规则自动继续。扩展使用一个共享正则 worker，因此多个可见编辑器不会并发运行正则 worker。

React aliases 的重叠优先级是确定的：精确语言（`javascriptreact` 或 `typescriptreact`）高于 sibling alias，sibling alias 高于通用 `react`。达到限制或配置无效时，会通过 VS Code 警告消息提示。

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
