import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import {
  bindAgent,
  getAgent,
  setAgentParticipating,
  setConversationPermission,
  unbindAgent,
  type AgentKind,
  type AgentStateDto,
} from '../services/core-api';
import type { SendMode } from '../features/conversations/send-routing';

/**
 * The round's settings belong to the conversation, and they are shown in the
 * right sidebar while the conversation page owns the sending. Sharing them
 * through one provider keeps a single source of truth instead of two copies
 * that drift apart.
 */
export function sendModeKey(conversationId: string): string {
  return `trinity.sendMode:${conversationId}`;
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;

  // The API client can reject with a plain { code, message } object.
  if (typeof value === 'object' && value !== null) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }

  return String(value);
}

interface ConversationControlsValue {
  conversationId: string | null;
  setConversationId: (id: string | null) => void;
  agentState: AgentStateDto | null;
  applyAgentState: (state: AgentStateDto | null) => void;
  refreshAgent: (id: string) => Promise<AgentStateDto | null>;
  sendMode: SendMode;
  chooseSendMode: (mode: SendMode) => void;
  toggleAgent: (kind: AgentKind) => Promise<void>;
  /** Resolves to null on success, or the reason it failed. */
  bindToWorkspace: (kind: AgentKind, workspacePath: string) => Promise<string | null>;
  unbind: () => Promise<void>;
  permissionMode: string | null;
  choosePermissionMode: (mode: string | null) => Promise<void>;
  busy: boolean;
  error: string | null;
  /** The page owns the draft, so it registers @-insertion here. */
  mentionRef: MutableRefObject<((kind: AgentKind) => void) | null>;
}

const ConversationControlsContext = createContext<ConversationControlsValue | null>(null);

export function ConversationControlsProvider({ children }: { children: ReactNode }) {
  const [conversationId, setConversationIdState] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<AgentStateDto | null>(null);
  const [sendMode, setSendMode] = useState<SendMode>('team');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mentionRef = useRef<((kind: AgentKind) => void) | null>(null);

  // Read inside callbacks so a toggle always acts on the conversation that is
  // current when the click lands, not on the one captured at render time.
  const conversationRef = useRef<string | null>(null);
  const agentRef = useRef<AgentStateDto | null>(null);

  useEffect(() => {
    conversationRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    agentRef.current = agentState;
  }, [agentState]);

  const setConversationId = useCallback((id: string | null) => {
    setConversationIdState((current) => (current === id ? current : id));
  }, []);

  useEffect(() => {
    setAgentState(null);
    setError(null);

    if (conversationId === null) {
      setSendMode('team');
      return;
    }

    let cancelled = false;

    void getAgent(conversationId)
      .then((state) => {
        if (!cancelled) setAgentState(state);
      })
      .catch(() => {
        if (!cancelled) setAgentState(null);
      });

    try {
      const stored = localStorage.getItem(sendModeKey(conversationId));
      setSendMode(stored === 'broadcast' || stored === 'codex' ? stored : 'team');
    } catch {
      setSendMode('team');
    }

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const applyAgentState = useCallback((state: AgentStateDto | null) => {
    setAgentState(state);
  }, []);

  const refreshAgent = useCallback(async (id: string): Promise<AgentStateDto | null> => {
    try {
      const state = await getAgent(id);

      // A late poll for a conversation the user already left must not repaint
      // the sidebar with someone else's lights.
      if (conversationRef.current === id) setAgentState(state);

      return state;
    } catch {
      return null;
    }
  }, []);

  const chooseSendMode = useCallback((mode: SendMode) => {
    setSendMode(mode);

    const id = conversationRef.current;
    if (id === null) return;

    try {
      localStorage.setItem(sendModeKey(id), mode);
    } catch {
      // A blocked storage must not stop the choice from working this session.
    }
  }, []);

  const toggleAgent = useCallback(
    async (kind: AgentKind) => {
      const id = conversationRef.current;
      if (id === null || busy) return;

      setBusy(true);

      try {
        const current = agentRef.current;
        const session = current?.bindings.find((row) => row.agent === kind) ?? null;
        const next =
          session === null
            ? await bindAgent(id, {
                agent: kind,
                active: !(current?.bindings ?? []).some((row) => row.active),
              })
            : await setAgentParticipating(id, kind, !session.participating);

        if (conversationRef.current === id) setAgentState(next);
        setError(null);
      } catch (caught) {
        setError(messageOf(caught));
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  /**
   * Binds an agent into the conversation, or points an already bound one at a
   * new directory. The resolved path is what the harness runs in, so it is sent
   * with the binding rather than kept only in the UI.
   */
  const bindToWorkspace = useCallback(
    async (kind: AgentKind, workspacePath: string): Promise<string | null> => {
      const id = conversationRef.current;
      if (id === null) return '没有打开的对话';
      if (busy) return '上一个操作还没完成';

      setBusy(true);

      try {
        const current = agentRef.current;
        const session = current?.bindings.find((row) => row.agent === kind) ?? null;
        const next = await bindAgent(id, {
          agent: kind,
          cwd: workspacePath,
          // An existing binding keeps its slot; a new one joins without
          // stealing the current agent unless nobody holds it.
          active: session ? session.active : !(current?.bindings ?? []).some((row) => row.active),
        });

        if (conversationRef.current === id) setAgentState(next);
        setError(null);
        return null;
      } catch (caught) {
        const message = messageOf(caught);
        setError(message);
        return message;
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const unbind = useCallback(async () => {
    const id = conversationRef.current;
    const kind = agentRef.current?.active_agent;
    if (id === null || !kind || busy) return;

    setBusy(true);

    try {
      const next = await unbindAgent(id, kind as AgentKind);
      if (conversationRef.current === id) setAgentState(next);
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const permissionMode = useMemo(() => {
    const bindings = agentState?.bindings ?? [];
    const active = bindings.find((binding) => binding.active) ?? bindings[0] ?? null;

    return active?.permission_mode ?? null;
  }, [agentState]);

  const choosePermissionMode = useCallback(async (mode: string | null) => {
    const id = conversationRef.current;
    if (id === null || busy) return;

    setBusy(true);

    try {
      const next = await setConversationPermission(
        id,
        mode as 'manual' | 'acceptEdits' | 'plan' | 'bypassPermissions' | null,
      );
      if (conversationRef.current === id) setAgentState(next);
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const value = useMemo(
    () => ({
      conversationId,
      setConversationId,
      agentState,
      applyAgentState,
      refreshAgent,
      sendMode,
      chooseSendMode,
      toggleAgent,
      bindToWorkspace,
      unbind,
      permissionMode,
      choosePermissionMode,
      busy,
      error,
      mentionRef,
    }),
    [
      conversationId,
      setConversationId,
      agentState,
      applyAgentState,
      refreshAgent,
      sendMode,
      chooseSendMode,
      toggleAgent,
      bindToWorkspace,
      unbind,
      permissionMode,
      choosePermissionMode,
      busy,
      error,
    ],
  );

  return (
    <ConversationControlsContext.Provider value={value}>
      {children}
    </ConversationControlsContext.Provider>
  );
}

export function useConversationControls(): ConversationControlsValue {
  const value = useContext(ConversationControlsContext);

  if (value === null) {
    throw new Error('useConversationControls must be used inside ConversationControlsProvider');
  }

  return value;
}
