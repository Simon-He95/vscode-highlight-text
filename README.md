Emphasize `v-if`, `v-else-if`, `v-else` in vue, because it is very important, I want to highlight it.

## Configuration
```typescript
  // You can configure the style you want through setting.
   "vscode-highlight-v-if.style": {
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
                "#B392F0": {
                  "match": ["v-xx"],
                  ...customerStyle
                }
            },
            "dark": {
            }
          },
          "description": "v-if style"
        }
```

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
