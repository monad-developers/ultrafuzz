import { describe, expect, it } from 'vitest';
import { createLiveRefreshGate, shouldPauseLiveRefresh } from '../../src/liveRefreshGate';

describe('shouldPauseLiveRefresh', () => {
  it('does not pause when the side panel is closed', () => {
    const gate = createLiveRefreshGate();
    gate.editorFocused = true;
    gate.pendingPromptEdit = true;
    expect(shouldPauseLiveRefresh(gate)).toBe(false);
  });

  it('pauses while the side panel editor is focused', () => {
    const gate = createLiveRefreshGate();
    gate.sidePanelOpen = true;
    gate.editorFocused = true;
    expect(shouldPauseLiveRefresh(gate)).toBe(true);
  });

  it('pauses while prompt or config edits are pending', () => {
    const gate = createLiveRefreshGate();
    gate.sidePanelOpen = true;
    gate.pendingConfigEdit = true;
    expect(shouldPauseLiveRefresh(gate)).toBe(true);

    gate.pendingConfigEdit = false;
    gate.pendingPromptEdit = true;
    expect(shouldPauseLiveRefresh(gate)).toBe(true);
  });
});
