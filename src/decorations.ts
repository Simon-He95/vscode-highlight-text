import type { DecorationRenderOptions, Range, TextEditor, TextEditorDecorationType } from 'vscode'
import { window } from 'vscode'

export class DecorationManager {
  private readonly activeStyles = new WeakMap<TextEditor, Set<string>>()
  private disposed = false
  private readonly editors = new Set<TextEditor>()
  private types: Map<string, TextEditorDecorationType>

  constructor(private styles: Map<string, DecorationRenderOptions>) {
    this.types = this.createTypes(styles)
  }

  apply(editor: TextEditor, rangesByStyle: Map<string, Range[]>): void {
    if (this.disposed)
      return
    this.editors.add(editor)
    const previous = this.activeStyles.get(editor) ?? new Set<string>()
    const current = new Set<string>()

    for (const [styleId, ranges] of rangesByStyle) {
      const type = this.types.get(styleId)
      if (!type)
        continue
      editor.setDecorations(type, ranges)
      current.add(styleId)
    }
    for (const styleId of previous) {
      if (!current.has(styleId))
        this.clearStyle(editor, styleId)
    }
    this.activeStyles.set(editor, current)
  }

  clear(editor: TextEditor): void {
    if (this.disposed)
      return
    for (const styleId of this.activeStyles.get(editor) ?? [])
      this.clearStyle(editor, styleId)
    this.activeStyles.delete(editor)
    this.editors.delete(editor)
  }

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    for (const editor of this.editors) {
      for (const styleId of this.activeStyles.get(editor) ?? [])
        this.clearStyle(editor, styleId)
    }
    this.editors.clear()
    this.disposeTypes(this.types)
    this.types.clear()
  }

  private clearStyle(editor: TextEditor, styleId: string): void {
    const type = this.types.get(styleId)
    if (!type)
      return
    try {
      editor.setDecorations(type, [])
    }
    catch {
      // Continue cleanup for the remaining editors and decoration types.
    }
  }

  private createTypes(styles: Map<string, DecorationRenderOptions>): Map<string, TextEditorDecorationType> {
    const types = new Map<string, TextEditorDecorationType>()
    try {
      for (const [styleId, options] of styles)
        types.set(styleId, window.createTextEditorDecorationType(options))
      return types
    }
    catch (error) {
      this.disposeTypes(types)
      throw error
    }
  }

  private disposeTypes(types: Map<string, TextEditorDecorationType>): void {
    for (const type of types.values()) {
      try {
        type.dispose()
      }
      catch {
        // Dispose all remaining types even if one VS Code API call fails.
      }
    }
  }
}
