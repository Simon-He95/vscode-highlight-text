import type { DecorationRenderOptions, Range, TextEditor, TextEditorDecorationType } from 'vscode'
import { window } from 'vscode'

interface DecorationProfile {
  editors: Set<TextEditor>
  types: Map<string, TextEditorDecorationType>
}

export class DecorationManager {
  private readonly activeStyles = new WeakMap<TextEditor, Set<string>>()
  private disposed = false
  private readonly failedProfiles = new Map<string, Error>()
  private readonly editorProfiles = new WeakMap<TextEditor, string>()
  private readonly profiles = new Map<string, DecorationProfile>()

  constructor(private readonly styles: Map<string, DecorationRenderOptions>) {}

  prepareProfile(profileId: string, priorityStyleIds: string[]): void {
    if (this.disposed || this.profiles.has(profileId))
      return
    const previousError = this.failedProfiles.get(profileId)
    if (previousError)
      throw previousError
    const types = new Map<string, TextEditorDecorationType>()
    try {
      for (const styleId of new Set(priorityStyleIds)) {
        const options = this.styles.get(styleId)
        if (options)
          types.set(styleId, window.createTextEditorDecorationType(options))
      }
      this.profiles.set(profileId, { editors: new Set(), types })
    }
    catch (error) {
      this.disposeTypes(types)
      const profileError = error instanceof Error ? error : new Error(String(error))
      this.failedProfiles.set(profileId, profileError)
      throw profileError
    }
  }

  apply(
    editor: TextEditor,
    rangesByStyle: Map<string, Range[]>,
    profileId: string,
    priorityStyleIds: string[],
  ): void {
    if (this.disposed)
      return
    const previousProfileId = this.editorProfiles.get(editor)
    try {
      this.prepareProfile(profileId, priorityStyleIds)
    }
    catch (error) {
      if (previousProfileId)
        this.detachEditor(editor, previousProfileId)
      throw error
    }
    if (previousProfileId && previousProfileId !== profileId)
      this.detachEditor(editor, previousProfileId)

    const profile = this.profiles.get(profileId)!
    profile.editors.add(editor)
    this.editorProfiles.set(editor, profileId)
    const previous = this.activeStyles.get(editor) ?? new Set<string>()
    const current = new Set<string>()
    for (const [styleId, ranges] of rangesByStyle) {
      const type = profile.types.get(styleId)
      if (!type)
        continue
      editor.setDecorations(type, ranges)
      current.add(styleId)
    }
    for (const styleId of previous) {
      if (!current.has(styleId))
        this.clearStyle(editor, profile, styleId)
    }
    this.activeStyles.set(editor, current)
  }

  clear(editor: TextEditor): void {
    if (this.disposed)
      return
    const profileId = this.editorProfiles.get(editor)
    if (profileId)
      this.detachEditor(editor, profileId)
  }

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    for (const profile of this.profiles.values()) {
      for (const editor of profile.editors) {
        for (const styleId of this.activeStyles.get(editor) ?? [])
          this.clearStyle(editor, profile, styleId)
      }
      this.disposeTypes(profile.types)
    }
    this.profiles.clear()
  }

  private detachEditor(editor: TextEditor, profileId: string): void {
    const profile = this.profiles.get(profileId)
    if (!profile)
      return
    for (const styleId of this.activeStyles.get(editor) ?? [])
      this.clearStyle(editor, profile, styleId)
    this.activeStyles.delete(editor)
    this.editorProfiles.delete(editor)
    profile.editors.delete(editor)
    if (!profile.editors.size) {
      this.disposeTypes(profile.types)
      this.profiles.delete(profileId)
    }
  }

  private clearStyle(editor: TextEditor, profile: DecorationProfile, styleId: string): void {
    const type = profile.types.get(styleId)
    if (!type)
      return
    try {
      editor.setDecorations(type, [])
    }
    catch {
      // Continue cleanup for the remaining editors and decoration types.
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
