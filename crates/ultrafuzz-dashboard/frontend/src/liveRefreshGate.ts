export type LiveRefreshGate = {
  editorFocused: boolean;
  pendingConfigEdit: boolean;
  pendingPromptEdit: boolean;
  sidePanelOpen: boolean;
};

export function createLiveRefreshGate(): LiveRefreshGate {
  return {
    sidePanelOpen: false,
    editorFocused: false,
    pendingPromptEdit: false,
    pendingConfigEdit: false
  };
}

export function shouldPauseLiveRefresh(gate: LiveRefreshGate): boolean {
  if (!gate.sidePanelOpen) {
    return false;
  }
  return gate.editorFocused || gate.pendingPromptEdit || gate.pendingConfigEdit;
}
