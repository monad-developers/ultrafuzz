import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validatePromptTemplateVariables } from './templateValidation';
import type { TemplateValidation } from './templateValidation';

export const promptAutosaveDelayMs = 1500;

type PromptSummary = {
  strategyId?: string;
  nodeId?: string;
  promptId: string;
  displayName: string;
  category?: string;
  source: string;
  path: string;
  editable: boolean;
  contentHash: string;
};

export type ManagedPromptDetail = {
  summary: PromptSummary;
  content: string;
  endpoint: string;
};

type SavePromptResponse = {
  strategyId?: string;
  nodeId?: string;
  path: string;
  contentHash: string;
  renamedFrom?: string;
  validation: {
    valid: boolean;
    message: string;
  };
};

type ArtifactReferenceContext = {
  knownNodeIds: string[];
  ancestorNodeIds: string[];
  currentNodeId?: string;
};

type UseManagedPromptEditorOptions = {
  sessionToken: string | null;
  promptEndpoint: string | null;
  isStrategyAggregate: boolean;
  templateVariables: readonly string[] | undefined;
  artifactReferenceContext: ArtifactReferenceContext | undefined;
  onMessage: (message: string) => void;
  onPendingEditChange?: (pending: boolean) => void;
  onRenamed: (nodeId: string) => void;
  refreshFlow: () => Promise<unknown>;
  refreshTopology: () => Promise<unknown>;
};

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function useManagedPromptEditor({
  sessionToken,
  promptEndpoint,
  isStrategyAggregate,
  templateVariables,
  artifactReferenceContext,
  onMessage,
  onPendingEditChange,
  onRenamed,
  refreshFlow,
  refreshTopology
}: UseManagedPromptEditorOptions) {
  const [prompt, setPrompt] = useState<ManagedPromptDetail | null>(null);
  const [promptDraft, setPromptDraft] = useState('');
  const [promptError, setPromptError] = useState('');
  const [promptSaving, setPromptSaving] = useState(false);
  const promptRef = useRef<ManagedPromptDetail | null>(prompt);
  const promptDraftRef = useRef(promptDraft);
  const promptEndpointRef = useRef<string | null>(promptEndpoint);
  const promptSaveChainRef = useRef<Promise<void>>(Promise.resolve());

  const promptTemplateValidation = useMemo(
    () => validatePromptTemplateVariables(promptDraft, templateVariables, artifactReferenceContext),
    [artifactReferenceContext, promptDraft, templateVariables]
  );

  useEffect(() => {
    promptDraftRef.current = promptDraft;
  }, [promptDraft]);

  useEffect(() => {
    promptRef.current = prompt;
    promptEndpointRef.current = promptEndpoint;
  }, [prompt, promptEndpoint]);

  useEffect(() => {
    if (!prompt) {
      onPendingEditChange?.(false);
      return;
    }
    onPendingEditChange?.(promptDraft !== prompt.content);
  }, [onPendingEditChange, prompt, promptDraft]);

  useEffect(() => {
    if (!promptEndpoint) {
      setPrompt(null);
      setPromptDraft('');
      setPromptError('');
      return;
    }

    let cancelled = false;
    setPrompt(null);
    setPromptDraft('');
    setPromptError('');

    getJson<Omit<ManagedPromptDetail, 'endpoint'>>(promptEndpoint)
      .then((promptDetail) => {
        if (cancelled) {
          return;
        }
        const loaded = { ...promptDetail, endpoint: promptEndpoint };
        promptRef.current = loaded;
        promptDraftRef.current = promptDetail.content;
        setPrompt(loaded);
        setPromptDraft(promptDetail.content);
      })
      .catch((error) => {
        if (!cancelled) {
          const kind = isStrategyAggregate ? 'Strategy' : 'Node';
          setPromptError(`${kind} Markdown failed to load: ${errorMessage(error)}`);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isStrategyAggregate, promptEndpoint]);

  const savePromptNow = useCallback(
    async (endpoint: string, content: string) => {
      if (!sessionToken) {
        return;
      }
      let activeEndpoint = endpoint;
      setPromptSaving(true);
      try {
        const response = await fetch(endpoint, {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'x-ultrafuzz-session': sessionToken
          },
          body: JSON.stringify({ content })
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const saved = (await response.json()) as SavePromptResponse;
        const renamedNodeId = saved.renamedFrom && saved.nodeId ? saved.nodeId : null;
        const nextEndpoint = renamedNodeId ? `/api/prompts/nodes/${encodeURIComponent(renamedNodeId)}` : endpoint;
        if (renamedNodeId) {
          activeEndpoint = nextEndpoint;
          promptEndpointRef.current = nextEndpoint;
          await refreshTopology();
          await refreshFlow();
          onRenamed(renamedNodeId);
        }
        const refreshed = await getJson<Omit<ManagedPromptDetail, 'endpoint'>>(nextEndpoint);
        if (!renamedNodeId && promptEndpointRef.current !== nextEndpoint) {
          return;
        }
        const currentPrompt = promptRef.current;
        const currentDraft = promptDraftRef.current;
        const draftStillMatchesVisibleBaseline = currentPrompt?.content === currentDraft;
        const draftStillMatchesSavedContent = currentDraft === content;
        const refreshedPrompt = { ...refreshed, endpoint: nextEndpoint };
        if (renamedNodeId) {
          onMessage('Saved and renamed prompt');
        }
        promptRef.current = refreshedPrompt;
        promptEndpointRef.current = nextEndpoint;
        const promptBaselineChanged =
          currentPrompt?.content !== refreshed.content ||
          currentPrompt?.summary.contentHash !== refreshed.summary.contentHash;
        if (promptBaselineChanged) {
          setPrompt(refreshedPrompt);
        }
        if (
          (draftStillMatchesSavedContent || draftStillMatchesVisibleBaseline) &&
          promptDraftRef.current !== refreshed.content
        ) {
          promptDraftRef.current = refreshed.content;
          setPromptDraft(refreshed.content);
        }
        setPromptError('');
      } catch (error) {
        if (promptEndpointRef.current !== activeEndpoint) {
          return;
        }
        const message = `Markdown save failed: ${errorMessage(error)}`;
        setPromptError(message);
        onMessage(message);
      } finally {
        setPromptSaving(false);
      }
    },
    [onMessage, onRenamed, refreshFlow, refreshTopology, sessionToken]
  );

  const queuePromptSave = useCallback(
    (endpoint: string, content: string) => {
      const nextSave = promptSaveChainRef.current.catch(() => undefined).then(() => savePromptNow(endpoint, content));
      promptSaveChainRef.current = nextSave.catch(() => undefined);
      return nextSave;
    },
    [savePromptNow]
  );

  const flushAutosave = useCallback(() => {
    const currentPrompt = promptRef.current;
    const content = promptDraftRef.current;
    if (
      !currentPrompt ||
      !currentPrompt.summary.editable ||
      content === currentPrompt.content ||
      !validatePromptTemplateVariables(content, templateVariables, artifactReferenceContext).valid
    ) {
      return;
    }
    queuePromptSave(currentPrompt.endpoint, content).catch(() => undefined);
  }, [artifactReferenceContext, queuePromptSave, templateVariables]);

  const savePrompt = useCallback(
    async (content: string) => {
      const currentPrompt = promptRef.current;
      if (!currentPrompt || !currentPrompt.summary.editable) {
        return;
      }
      if (!validatePromptTemplateVariables(content, templateVariables, artifactReferenceContext).valid) {
        return;
      }
      await queuePromptSave(currentPrompt.endpoint, content);
    },
    [artifactReferenceContext, queuePromptSave, templateVariables]
  );

  useEffect(() => {
    if (
      !prompt ||
      !sessionToken ||
      !prompt.summary.editable ||
      promptSaving ||
      promptDraft === prompt.content ||
      !promptTemplateValidation.valid
    ) {
      return;
    }
    const autosaveTimer = window.setTimeout(() => {
      savePrompt(promptDraft).catch(() => undefined);
    }, promptAutosaveDelayMs);
    return () => window.clearTimeout(autosaveTimer);
  }, [prompt, promptDraft, promptSaving, promptTemplateValidation.valid, savePrompt, sessionToken]);

  useEffect(() => () => flushAutosave(), [flushAutosave]);

  return {
    prompt,
    promptDraft,
    promptError,
    promptSaving,
    promptTemplateValidation,
    setPromptDraft
  };
}

export type ManagedPromptEditorState = {
  prompt: ManagedPromptDetail | null;
  promptDraft: string;
  promptError: string;
  promptSaving: boolean;
  promptTemplateValidation: TemplateValidation;
  setPromptDraft: (value: string) => void;
};
