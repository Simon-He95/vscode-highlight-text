<p align="center">
<img height="200" src="./icon.png" alt="vscode-highlight-text">
</p>
<p align="center"> English | <a href="./README_zh.md">简体中文</a></p>

Customize the highlight syntax of any language, such as vue, react, svelte, solid, etc. You can emphasize some specific syntax or events, make it easier for you to read the code and make your editor look more unique. If you think your matching style is cool, welcome to mention pr, which can be used as a built-in template style for more people.

![demo](/assets/demo.jpg)

## Configuration
> ⚠️ Please note that the following indicates the type of configuration. For more information on how to configure, please refer to [shared rules](https://github.com/Simon-He95/vscode-highlight-text/issues/5)

```json
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
### 1. You can apply the same configuration to multiple type files separated by `|`. The following example is a common configuration for `react, typescript, and javascript`

```json
{
  "react|typescript|javascript": {
    "light": {},
    "dark": {}
  }
}
```

### 2. You can set different styles for multiple match items in a regular rule

  - Example 1:

  ```md
   "match": ["(function)\\s+([\\w]*)"], this regular match matches `match1: function` and `match2: functionName`
   "colors": ["red", "yellow"], this colors can set match1 to red and match2 to yellow
  ```
   > Example 1 is just a convenient use of color. If you want more attributes, you can refer to Example 2.

  - Example 2:

  ```md
   "match": ["(function)\\s+([\\w]*)"], this regular match matches `match1: function` and `match2: functionName`
   "matchCss": [{
     "color": "red",
     "before": {
       "contentText": "✨"
     }
   },{
     "color": "yellow"
   }]
   ```

### 3. You can use `ignoreReg` to filter unwanted content
  ```md
   "match": ["(function)\\s+([\\w]*)"], this regular match matches `match1: function` and `match2: functionName`
   "ignoreReg": [
    "```([^`])+``` "// I don’t want the content of match to be between ``` and ```
   ]
   ```

### 4. Support RegExp flags passing
  ```md
   "red": ["[0-9]+","gm"]
   ```

## Show your style

- You can share the style you think is cool [here](https://github.com/Simon-He95/vscode-highlight-text/issues/5), or you can submit PR as a built-in template style selection Make it available to more people.

## :coffee:

[buy me a cup of coffee](https://github.com/Simon-He95/sponsor)

## License

[MIT](./license)

## Sponsors

<p align="center">
  <a href="https://cdn.jsdelivr.net/gh/Simon-He95/sponsor/sponsors.svg">
    <img src="https://cdn.jsdelivr.net/gh/Simon-He95/sponsor/sponsors.png"/>
  </a>
</p>
