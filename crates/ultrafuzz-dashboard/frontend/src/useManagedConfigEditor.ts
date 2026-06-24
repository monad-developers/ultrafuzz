import { useCallback, useEffect, useState } from 'react';

export type ManagedConfigDetail = {
  path: string;
  source: string;
  editable: boolean;
  content: string;
  contentHash: string;
};

type UseManagedConfigEditorOptions = {
  config: ManagedConfigDetail;
  onPendingEditChange?: (pending: boolean) => void;
  onSave: (content: string) => Promise<void>;
};

export function useManagedConfigEditor({ config, onPendingEditChange, onSave }: UseManagedConfigEditorOptions) {
  const { content, contentHash, path } = config;
  const [configDraft, setConfigDraft] = useState(content);

  useEffect(() => {
    setConfigDraft(content);
  }, [content, contentHash, path]);

  useEffect(() => {
    onPendingEditChange?.(configDraft !== content);
  }, [content, configDraft, onPendingEditChange]);

  const saveConfig = useCallback(async () => {
    await onSave(configDraft);
  }, [configDraft, onSave]);

  return {
    configDraft,
    saveConfig,
    setConfigDraft
  };
}
