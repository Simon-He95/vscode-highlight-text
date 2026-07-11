import type { DecorationRenderOptions, Range, TextEditor, TextEditorDecorationType } from 'vscode'
import { window } from 'vscode'

export class DecorationManager {
  private disposed = false
  private readonly editors = new Set<TextEditor>()
  private readonly types = new Map<string, TextEditorDecorationType>()

  constructor(private styles: Map<string, DecorationRenderOptions>) {}

  apply(editor: TextEditor, rangesByStyle: Map<string, Range[]>): void {
    if (this.disposed)
      return
    this.editors.add(editor)
    for (const [styleId, ranges] of rangesByStyle) {
      const options = this.styles.get(styleId)
      if (!options)
        continue
      if (!this.types.has(styleId))
        this.types.set(styleId, window.createTextEditorDecorationType(options))
      editor.setDecorations(this.types.get(styleId)!, ranges)
    }
    for (const [styleId, type] of this.types) {
      if (!rangesByStyle.has(styleId))
        editor.setDecorations(type, [])
    }
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
