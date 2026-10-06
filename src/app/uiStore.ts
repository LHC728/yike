/**
 * 极轻量的界面状态：当前打开的记录、搜索、设置、选中的日历日期。
 * 用模块级 store + useSyncExternalStore，避免层层透传 props。
 */
import { useSyncExternalStore } from 'react'

export interface UiState {
  selectedRecordId: string | null
  searchOpen: boolean
  settingsOpen: boolean
  selectedDate: string | null
}

const INITIAL: UiState = {
  selectedRecordId: null,
  searchOpen: false,
  settingsOpen: false,
  selectedDate: null,
}

class UiStore {
  private listeners = new Set<() => void>()
  private state: UiState = INITIAL

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): UiState => this.state

  set(patch: Partial<UiState>): void {
    const next = { ...this.state, ...patch }
    if (
      next.selectedRecordId === this.state.selectedRecordId &&
      next.searchOpen === this.state.searchOpen &&
      next.settingsOpen === this.state.settingsOpen &&
      next.selectedDate === this.state.selectedDate
    ) {
      return
    }
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

export const uiStore = new UiStore()

export function useUi(): UiState {
  return useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot, uiStore.getSnapshot)
}

export const uiActions = {
  reset(): void {
    uiStore.set(INITIAL)
  },
  openRecord(recordId: string): void {
    uiStore.set({ selectedRecordId: recordId })
  },
  closeRecord(): void {
    uiStore.set({ selectedRecordId: null })
  },
  openSearch(): void {
    uiStore.set({ searchOpen: true })
  },
  closeSearch(): void {
    uiStore.set({ searchOpen: false })
  },
  openSettings(): void {
    uiStore.set({ settingsOpen: true })
  },
  closeSettings(): void {
    uiStore.set({ settingsOpen: false })
  },
  selectDate(date: string | null): void {
    uiStore.set({ selectedDate: date })
  },
}
