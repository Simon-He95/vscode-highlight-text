import type { DecorationRenderOptions, Range, TextEditor, TextEditorDecorationType } from 'vscode'
import { window } from 'vscode'

function styleKey(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(styleKey).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${styleKey(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export class DecorationManager {
  private disposed = false
  private readonly editors = new Set<TextEditor>()
  private readonly types = new Map<string, TextEditorDecorationType>()

  constructor(private styles: Map<string, DecorationRenderOptions>) {}

  apply(editor: TextEditor, rangesByStyle: Map<string, Range[]>): void {
    if (this.disposed)
      return
    this.editors.add(editor)
    const rangesByType = new Map<string, Range[]>()
    for (const [styleId, ranges] of rangesByStyle) {
      const options = this.styles.get(styleId)
      if (!options)
        continue
      const key = styleKey(options)
      rangesByType.set(key, [...(rangesByType.get(key) ?? []), ...ranges])
      if (!this.types.has(key))
        this.types.set(key, window.createTextEditorDecorationType(options))
    }

    for (const [key, type] of this.types)
      editor.setDecorations(type, rangesByType.get(key) ?? [])
  }

  clear(editor: TextEditor): void {
    if (this.disposed)
      return
    for (const type of this.types.values())
      editor.setDecorations(type, [])
    this.editors.delete(editor)
  }

  rebuild(styles: Map<string, DecorationRenderOptions>): void {
    if (this.disposed)
      return
    for (const editor of [...this.editors])
      this.clear(editor)
    for (const type of this.types.values())
      type.dispose()
    this.types.clear()
    this.styles = styles
  }

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    for (const editor of this.editors) {
      for (const type of this.types.values())
        editor.setDecorations(type, [])
    }
    this.editors.clear()
    for (const type of this.types.values())
      type.dispose()
    this.types.clear()
  }
}
