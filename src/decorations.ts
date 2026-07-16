import type { DecorationRenderOptions, Range, TextEditor, TextEditorDecorationType } from 'vscode'
import { window } from 'vscode'

const MAX_MANAGER_DECORATION_TYPES = 1_500

export class DecorationBudgetExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecorationBudgetExceededError'
  }
}

type DecorationLayer = string | { id: string, styleId: string }

interface DecorationProfile {
  disposed: boolean
  editors: Set<TextEditor>
  types: Map<string, TextEditorDecorationType>
}

export class DecorationManager {
  private readonly activeStyles = new WeakMap<TextEditor, Set<string>>()
  private disposed = false
  private readonly failedProfiles = new Map<string, Error>()
  private readonly editorProfiles = new WeakMap<TextEditor, string>()
  private readonly profiles = new Map<string, DecorationProfile>()
  private typeCount = 0

  constructor(private readonly styles: Map<string, DecorationRenderOptions>) {}

  prepareProfile(profileId: string, priorityStyleIds: DecorationLayer[]): void {
    if (this.disposed || this.profiles.has(profileId))
      return
    const previousError = this.failedProfiles.get(profileId)
    if (previousError)
      throw previousError
    const layers = [...new Map(priorityStyleIds.map((layer) => {
      const normalized = typeof layer === 'string' ? { id: layer, styleId: layer } : layer
      return [normalized.id, normalized]
    })).values()].filter(layer => this.styles.has(layer.styleId))
    if (this.typeCount + layers.length > MAX_MANAGER_DECORATION_TYPES)
      throw new DecorationBudgetExceededError(`Decoration type budget exceeded: at most ${MAX_MANAGER_DECORATION_TYPES} active types are allowed`)
    const types = new Map<string, TextEditorDecorationType>()
    try {
      // Keep high-to-low creation order: current VS Code prepends decoration CSS rules,
      // so earlier-created, higher-priority layers end up later in the cascade.
      for (const { id, styleId } of layers) {
        try {
          types.set(id, window.createTextEditorDecorationType(this.styles.get(styleId)!))
        }
        catch (error) {
          throw new Error(`Failed to create decoration layer ${id} (style ${styleId}): ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      this.typeCount += types.size
      this.profiles.set(profileId, { disposed: false, editors: new Set(), types })
    }
    catch (error) {
      this.disposeTypes(types)
      const profileError = error instanceof Error ? error : new Error(String(error))
      this.failedProfiles.set(profileId, profileError)
      throw profileError
    }
  }

  reserveProfile(editor: TextEditor, profileId: string, priorityStyleIds: DecorationLayer[]): void {
    if (this.disposed)
      return
    const previousProfileId = this.editorProfiles.get(editor)
    const previousProfile = previousProfileId ? this.profiles.get(previousProfileId) : undefined
    if (previousProfileId !== profileId && previousProfile?.editors.size === 1)
      this.detachEditor(editor, true, previousProfileId!)
    try {
      this.prepareProfile(profileId, priorityStyleIds)
    }
    catch (error) {
      if (previousProfileId)
        this.detachEditor(editor, true, previousProfileId)
      throw error
    }
    if (previousProfileId && previousProfileId !== profileId)
      this.detachEditor(editor, true, previousProfileId)
    const profile = this.profiles.get(profileId)!
    profile.editors.add(editor)
    this.editorProfiles.set(editor, profileId)
    if (!this.activeStyles.has(editor))
      this.activeStyles.set(editor, new Set())
  }

  apply(
    editor: TextEditor,
    rangesByStyle: Map<string, Range[]>,
    profileId: string,
    priorityStyleIds: DecorationLayer[],
  ): void {
    if (this.disposed)
      return
    this.reserveProfile(editor, profileId, priorityStyleIds)
    const profile = this.profiles.get(profileId)!
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

  clearRanges(editor: TextEditor): void {
    if (this.disposed)
      return
    const profileId = this.editorProfiles.get(editor)
    const profile = profileId ? this.profiles.get(profileId) : undefined
    if (!profile)
      return
    for (const styleId of this.activeStyles.get(editor) ?? [])
      this.clearStyle(editor, profile, styleId)
    this.activeStyles.set(editor, new Set())
  }

  releaseEditor(editor: TextEditor): void {
    this.detachEditor(editor, true)
  }

  forgetEditor(editor: TextEditor): void {
    this.detachEditor(editor, false)
  }

  clearEditors(): void {
    if (this.disposed)
      return
    for (const [profileId, profile] of [...this.profiles]) {
      for (const editor of [...profile.editors])
        this.detachEditor(editor, true, profileId)
    }
  }

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    for (const profile of this.profiles.values())
      this.disposeProfile(profile)
    this.profiles.clear()
  }

  private detachEditor(editor: TextEditor, clearRanges: boolean, expectedProfileId?: string): void {
    if (this.disposed)
      return
    const profileId = expectedProfileId ?? this.editorProfiles.get(editor)
    if (!profileId)
      return
    const profile = this.profiles.get(profileId)
    if (!profile)
      return
    if (clearRanges) {
      for (const styleId of this.activeStyles.get(editor) ?? [])
        this.clearStyle(editor, profile, styleId)
    }
    this.activeStyles.delete(editor)
    this.editorProfiles.delete(editor)
    profile.editors.delete(editor)
    if (!profile.editors.size) {
      this.disposeProfile(profile)
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

  private disposeProfile(profile: DecorationProfile): void {
    if (profile.disposed)
      return
    profile.disposed = true
    this.typeCount -= profile.types.size
    this.disposeTypes(profile.types)
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
