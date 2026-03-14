import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';

import type { AttachmentSummary, ApiHealth, ChatMessage, ModelOption, ProjectSummary } from '@github-personal-assistant/shared';

import { MessageBubble } from '@/components/message-bubble';
import { Screen } from '@/components/screen';
import { createProject, getHealth, getModels, getProjects, streamChat, uploadAttachment } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

type LocalChat = {
  id: string;
  title: string;
  projectId?: string;
  projectName?: string;
  sessionId?: string;
  model: string;
  messages: ChatMessage[];
  draftAttachments: AttachmentSummary[];
  updatedAt: string;
};

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const createMessage = (
  role: ChatMessage['role'],
  content: string,
  attachments?: AttachmentSummary[],
): ChatMessage => ({
  id: createId(),
  role,
  content,
  ...(attachments && attachments.length > 0 ? { attachments } : {}),
});

const summarizeTitle = (prompt: string) => {
  const singleLine = prompt.replace(/\s+/g, ' ').trim();
  return singleLine.length > 42 ? `${singleLine.slice(0, 42)}...` : singleLine;
};

const buildChat = ({
  model,
  project,
}: {
  model: string;
  project?: ProjectSummary;
}): LocalChat => ({
  id: createId(),
  title: project ? project.name : 'New chat',
  projectId: project?.id,
  projectName: project?.name,
  model: project?.defaultModel ?? model,
  draftAttachments: [],
  updatedAt: new Date().toISOString(),
  messages: [
    createMessage(
      'assistant',
      project
        ? `Project context is attached for ${project.name}. Ask anything and real Copilot errors will appear inline.`
        : 'Start a new conversation. Projects are optional, and real Copilot errors will appear inline.',
    ),
  ],
});

export default function HomeScreen() {
  const { width } = useWindowDimensions();
  const compact = width < 960;
  const { openPendingGitHubVerification, pendingDeviceAuth, session, signInWithGitHub, signOut } = useAuth();

  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [chats, setChats] = useState<LocalChat[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [loading, setLoading] = useState(true);
  const [creatingProject, setCreatingProject] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [streamingChatId, setStreamingChatId] = useState<string | null>(null);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesScrollRef = useRef<ScrollView>(null);

  const defaultModel = models[0]?.id ?? 'gpt-5-mini';

  useEffect(() => {
    if (!session) {
      setProjects([]);
      setModels([]);
      setChats([]);
      setSelectedChatId(null);
      setDraft('');
    }
  }, [session]);

  const updateChat = useCallback((chatId: string, updater: (chat: LocalChat) => LocalChat) => {
    setChats((current) => current.map((chat) => (chat.id === chatId ? updater(chat) : chat)));
  }, []);

  const ensureSelectedChat = useCallback((availableModels: ModelOption[]) => {
    const initialModel = availableModels[0]?.id ?? 'gpt-5-mini';
    const chat = buildChat({ model: initialModel });
    setChats([chat]);
    setSelectedChatId(chat.id);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      if (!session) {
        const healthPayload = await getHealth();
        setHealth(healthPayload);
        return;
      }

      const [healthPayload, projectsPayload, modelsPayload] = await Promise.all([
        getHealth(),
        getProjects(session.sessionToken),
        getModels(session.sessionToken),
      ]);

      setHealth(healthPayload);
      setProjects(projectsPayload.projects);
      setModels(modelsPayload.models);

      setChats((current) => {
        if (current.length > 0) {
          return current.map((chat) => ({
            ...chat,
            model: chat.model || modelsPayload.models[0]?.id || 'gpt-5-mini',
          }));
        }

        const chat = buildChat({ model: modelsPayload.models[0]?.id ?? 'gpt-5-mini' });
        setSelectedChatId(chat.id);
        return [chat];
      });
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : 'Failed to load the assistant.';
      setError(message);

      if (/session expired|sign in/i.test(message)) {
        void signOut();
      }
    } finally {
      setLoading(false);
    }
  }, [session, signOut]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (session && !loading && chats.length === 0) {
      ensureSelectedChat(models);
    }
  }, [chats.length, ensureSelectedChat, loading, models, session]);

  const selectedChat = useMemo(
    () => chats.find((chat) => chat.id === selectedChatId) ?? chats[0] ?? null,
    [chats, selectedChatId],
  );

  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedChat?.model) ?? models[0] ?? null,
    [models, selectedChat?.model],
  );

  const orderedChats = useMemo(
    () => [...chats].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [chats],
  );

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      messagesScrollRef.current?.scrollToEnd({ animated: true });
    }, 0);

    return () => clearTimeout(timeoutId);
  }, [selectedChat?.id, selectedChat?.messages]);

  const handleAuthPress = useCallback(() => {
    setError(null);

    const action = pendingDeviceAuth ? openPendingGitHubVerification() : signInWithGitHub();
    void action.catch((authError) => {
      setError(authError instanceof Error ? authError.message : 'Unable to complete GitHub sign-in.');
    });
  }, [openPendingGitHubVerification, pendingDeviceAuth, signInWithGitHub]);

  const handleCreateChat = useCallback(() => {
    const chat = buildChat({ model: defaultModel });
    setChats((current) => [chat, ...current]);
    setSelectedChatId(chat.id);
    setDraft('');
  }, [defaultModel]);

  const handleStartProjectChat = useCallback(
    (project: ProjectSummary) => {
      const chat = buildChat({ model: defaultModel, project });
      setChats((current) => [chat, ...current]);
      setSelectedChatId(chat.id);
      setDraft('');
    },
    [defaultModel],
  );

  const handleCreateProject = useCallback(async () => {
    if (!session || !newProjectName.trim()) {
      return;
    }

    setCreatingProject(true);
    setError(null);

    try {
      const payload = await createProject({ name: newProjectName.trim() }, session.sessionToken);
      setProjects((current) => [payload.project, ...current]);
      setNewProjectName('');
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : 'Unable to create project.';
      setError(message);
    } finally {
      setCreatingProject(false);
    }
  }, [newProjectName, session]);

  const handleSelectModel = useCallback(
    (modelId: string) => {
      if (!selectedChat) {
        return;
      }

      updateChat(selectedChat.id, (chat) => ({ ...chat, model: modelId }));
      setModelPickerVisible(false);
    },
    [selectedChat, updateChat],
  );

  const handleAddAttachment = useCallback(async () => {
    if (!session || !selectedChat || uploadingAttachment) {
      return;
    }

    setUploadingAttachment(true);
    setError(null);

    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
        type: '*/*',
      });

      if (result.canceled) {
        return;
      }

      const remainingSlots = Math.max(0, 5 - selectedChat.draftAttachments.length);
      if (remainingSlots === 0) {
        setError('You can attach up to 5 files per message.');
        return;
      }

      const nextAssets = result.assets.slice(0, remainingSlots);
      const uploadedAttachments: AttachmentSummary[] = [];

      for (const asset of nextAssets) {
        const payload = await uploadAttachment(
          {
            uri: asset.uri,
            name: asset.name,
            mimeType: asset.mimeType ?? 'application/octet-stream',
            file: 'file' in asset ? asset.file : undefined,
          },
          session.sessionToken,
        );
        uploadedAttachments.push(payload.attachment);
      }

      if (uploadedAttachments.length > 0) {
        updateChat(selectedChat.id, (chat) => ({
          ...chat,
          draftAttachments: [...chat.draftAttachments, ...uploadedAttachments],
        }));
      }
    } catch (attachmentError) {
      setError(attachmentError instanceof Error ? attachmentError.message : 'Unable to attach file.');
    } finally {
      setUploadingAttachment(false);
    }
  }, [selectedChat, session, updateChat, uploadingAttachment]);

  const handleRemoveAttachment = useCallback(
    (attachmentId: string) => {
      if (!selectedChat) {
        return;
      }

      updateChat(selectedChat.id, (chat) => ({
        ...chat,
        draftAttachments: chat.draftAttachments.filter((attachment) => attachment.id !== attachmentId),
      }));
    },
    [selectedChat, updateChat],
  );

  const handleSend = useCallback(async () => {
    if (!session || !selectedChat || !draft.trim() || streamingChatId) {
      return;
    }

    const prompt = draft.trim();
    const assistantMessageId = createId();
    const chatId = selectedChat.id;
    const model = selectedChat.model || defaultModel;
    const projectId = selectedChat.projectId;
    const sessionId = selectedChat.sessionId;
    const messageAttachments = selectedChat.draftAttachments;
    let pendingDelta = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushPendingDelta = () => {
      if (!pendingDelta) {
        return;
      }

      const nextDelta = pendingDelta;
      pendingDelta = '';
      updateChat(chatId, (chat) => ({
        ...chat,
        updatedAt: new Date().toISOString(),
        messages: chat.messages.map((message) =>
          message.id === assistantMessageId
            ? { ...message, content: `${message.content}${nextDelta}` }
            : message,
        ),
      }));
    };

    const scheduleFlush = () => {
      if (flushTimer !== null) {
        return;
      }

      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushPendingDelta();
      }, 16);
    };

    setDraft('');
    setError(null);
    setStreamingChatId(chatId);
    updateChat(chatId, (chat) => ({
      ...chat,
      title: chat.title === 'New chat' ? summarizeTitle(prompt) : chat.title,
      model,
      updatedAt: new Date().toISOString(),
      draftAttachments: [],
      messages: [
        ...chat.messages,
        createMessage('user', prompt, messageAttachments),
        { id: assistantMessageId, role: 'assistant', content: '' },
      ],
    }));

    try {
      await streamChat(
        {
          projectId,
          prompt,
          model,
          sessionId,
          attachments: messageAttachments.map((attachment) => attachment.id),
        },
        session.sessionToken,
        (event) => {
          if (event.type === 'session') {
            updateChat(chatId, (chat) => ({ ...chat, sessionId: event.sessionId }));
            return;
          }

          if (event.type === 'chunk') {
            pendingDelta += event.delta;
            scheduleFlush();
            return;
          }

          if (event.type === 'error') {
            if (flushTimer !== null) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
            flushPendingDelta();
            updateChat(chatId, (chat) => ({
              ...chat,
              updatedAt: new Date().toISOString(),
              messages: chat.messages.map((message) =>
                message.id === assistantMessageId
                  ? { ...message, role: 'error', content: event.message }
                  : message,
              ),
            }));
            setError(event.message);
          }
        },
      );
    } catch (sendError) {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushPendingDelta();
      const message = sendError instanceof Error ? sendError.message : 'Unable to send message.';
      updateChat(chatId, (chat) => ({
        ...chat,
        updatedAt: new Date().toISOString(),
        messages: chat.messages.map((messageItem) =>
          messageItem.id === assistantMessageId
            ? { ...messageItem, role: 'error', content: message }
            : messageItem,
        ),
      }));
      setError(message);

      if (/session expired|sign in/i.test(message)) {
        void signOut();
      }
    } finally {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
      }
      flushPendingDelta();
      setStreamingChatId(null);
    }
  }, [defaultModel, draft, selectedChat, session, signOut, streamingChatId, updateChat]);

  const renderPendingDeviceAuth = () => {
    if (!pendingDeviceAuth) {
      return null;
    }

    return (
      <View style={styles.deviceAuthCard}>
        <Text style={styles.deviceAuthLabel}>GitHub device sign-in</Text>
        <Text style={styles.deviceAuthCode}>{pendingDeviceAuth.userCode}</Text>
        <Text style={styles.deviceAuthBody}>
          Open GitHub&apos;s verification page, enter the code, and this screen will keep polling until sign-in completes.
        </Text>
        <Text style={styles.deviceAuthLink}>{pendingDeviceAuth.verificationUri}</Text>
        <Text style={styles.deviceAuthMeta}>
          Expires at {new Date(pendingDeviceAuth.expiresAt).toLocaleTimeString()} · polling every {pendingDeviceAuth.interval}s
        </Text>
      </View>
    );
  };

  if (!session) {
    return (
      <Screen>
        <View style={styles.centeredLayout}>
          <View style={styles.signInCard}>
            <Text style={styles.eyebrow}>Github Personal Assistant</Text>
            <Text style={styles.signInTitle}>You must sign in to use this product.</Text>
            <Text style={styles.signInBody}>
              Use GitHub device OAuth to unlock the real Copilot-backed experience on web and Android.
            </Text>

            {renderPendingDeviceAuth()}

            {!pendingDeviceAuth && health && !health.authConfigured ? (
              <View style={styles.configHint}>
                <Text style={styles.configHintTitle}>GitHub sign-in setup</Text>
                <Text style={styles.configHintBody}>
                  Copy <Text style={styles.configHintCode}>.env.example</Text> to <Text style={styles.configHintCode}>.env</Text>, set
                  <Text style={styles.configHintCode}> GITHUB_CLIENT_ID</Text>, and restart the API.
                </Text>
              </View>
            ) : null}

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <Pressable style={styles.primaryButton} onPress={handleAuthPress}>
              <Text style={styles.primaryButtonText}>{pendingDeviceAuth ? 'Open verification page' : 'Sign in with GitHub'}</Text>
            </Pressable>
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={[styles.shell, compact && styles.shellCompact]}>
        <View style={[styles.sidebar, compact && styles.sidebarCompact]}>
          <View style={styles.sidebarHeader}>
            <Text style={styles.sidebarTitle}>Github Personal Assistant</Text>
            <Text style={styles.sidebarSubtitle}>@{session.user.login}</Text>
          </View>

          <Pressable style={styles.newChatButton} onPress={handleCreateChat}>
            <Text style={styles.primaryButtonText}>+ New chat</Text>
          </Pressable>

          <ScrollView style={styles.sidebarScroll} contentContainerStyle={styles.sidebarContent}>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Chats</Text>
              <View style={styles.sidebarList}>
                {orderedChats.map((chat) => {
                  const active = chat.id === selectedChat?.id;
                  return (
                    <Pressable
                      key={chat.id}
                      style={[styles.sidebarItem, active && styles.sidebarItemActive]}
                      onPress={() => setSelectedChatId(chat.id)}
                    >
                      <Text style={styles.sidebarItemTitle}>{chat.title}</Text>
                      <Text style={styles.sidebarItemMeta}>{chat.projectName ?? 'General chat'}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionTitle}>Projects</Text>
                <Text style={styles.sectionHint}>Optional</Text>
              </View>
              <View style={styles.createProjectCard}>
                <TextInput
                  placeholder="Create a project"
                  placeholderTextColor="#64748b"
                  value={newProjectName}
                  onChangeText={setNewProjectName}
                  style={styles.sidebarInput}
                />
                <Pressable
                  style={[styles.secondaryButton, creatingProject && styles.disabledButton]}
                  onPress={handleCreateProject}
                  disabled={creatingProject}
                >
                  <Text style={styles.secondaryButtonText}>{creatingProject ? 'Creating...' : 'Add project'}</Text>
                </Pressable>
              </View>
              <View style={styles.sidebarList}>
                {projects.map((project) => (
                  <Pressable key={project.id} style={styles.sidebarItem} onPress={() => handleStartProjectChat(project)}>
                    <Text style={styles.sidebarItemTitle}>{project.name}</Text>
                    <Text style={styles.sidebarItemMeta}>Start project chat</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </ScrollView>
        </View>

        <View style={styles.mainPanel}>
          <View style={styles.mainHeader}>
            <View style={styles.mainHeaderText}>
              <Text style={styles.chatTitle}>{selectedChat?.title ?? 'New chat'}</Text>
              <Text style={styles.chatSubtitle}>
                {selectedChat?.projectName ? `Project: ${selectedChat.projectName}` : 'No project attached'}
                {selectedChat?.sessionId ? ' · resumable' : ''}
              </Text>
            </View>
            <View style={styles.headerActions}>
              <Pressable style={styles.modelPillButton} onPress={() => setModelPickerVisible(true)}>
                <Text style={styles.modelPillText}>{selectedModel?.name ?? 'Choose model'}</Text>
                <Text style={styles.modelPillChevron}>▾</Text>
              </Pressable>
              <Pressable style={styles.settingsButton} onPress={() => setSettingsVisible(true)}>
                <Text style={styles.settingsButtonText}>⚙</Text>
              </Pressable>
            </View>
          </View>

          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color="#60a5fa" />
              <Text style={styles.loadingText}>Loading the assistant...</Text>
            </View>
          ) : null}

          {error ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <ScrollView ref={messagesScrollRef} style={styles.messagesScroll} contentContainerStyle={styles.messageList}>
            {(selectedChat?.messages ?? []).map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
          </ScrollView>

          <View style={styles.composerCard}>
            {selectedChat?.draftAttachments.length ? (
              <View style={styles.draftAttachmentList}>
                {selectedChat.draftAttachments.map((attachment) => (
                  <View key={attachment.id} style={styles.draftAttachmentChip}>
                    <Text style={styles.draftAttachmentText}>{attachment.name}</Text>
                    <Pressable onPress={() => handleRemoveAttachment(attachment.id)}>
                      <Text style={styles.draftAttachmentRemove}>×</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}

            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={selectedChat?.projectName ? `Ask about ${selectedChat.projectName}...` : 'Ask anything...'}
              placeholderTextColor="#64748b"
              multiline
              blurOnSubmit
              onSubmitEditing={() => {
                void handleSend();
              }}
              returnKeyType="send"
              enablesReturnKeyAutomatically
              style={styles.composerInput}
            />
            <View style={styles.composerFooter}>
              <View style={styles.composerMeta}>
                <View style={styles.composerTools}>
                  <Pressable
                    style={[styles.inlineModelButton, uploadingAttachment && styles.disabledButton]}
                    onPress={() => {
                      void handleAddAttachment();
                    }}
                    disabled={uploadingAttachment}
                  >
                    <Text style={styles.inlineModelButtonText}>
                      {uploadingAttachment ? 'Uploading...' : 'Attach file'}
                    </Text>
                  </Pressable>
                  <Pressable style={styles.inlineModelButton} onPress={() => setModelPickerVisible(true)}>
                    <Text style={styles.inlineModelButtonText}>{selectedModel?.name ?? 'Choose model'}</Text>
                    <Text style={styles.modelPillChevron}>▾</Text>
                  </Pressable>
                </View>
                <Text style={styles.helperText}>Enter to send · Shift+Enter for newline · up to 5 files</Text>
              </View>
              <Pressable
                style={[
                  styles.primaryButton,
                  styles.sendButton,
                  (Boolean(streamingChatId) || !draft.trim()) && styles.disabledButton,
                ]}
                onPress={() => {
                  void handleSend();
                }}
                disabled={Boolean(streamingChatId) || !draft.trim()}
              >
                <Text style={styles.primaryButtonText}>{streamingChatId ? 'Streaming...' : 'Send'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>

      <Modal animationType="fade" transparent visible={settingsVisible} onRequestClose={() => setSettingsVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Settings</Text>
            <Text style={styles.modalBody}>Signed in as @{session.user.login}</Text>
            <View style={styles.modalActions}>
              <Pressable style={styles.secondaryButton} onPress={() => setSettingsVisible(false)}>
                <Text style={styles.secondaryButtonText}>Close</Text>
              </Pressable>
              <Pressable
                style={styles.primaryButton}
                onPress={() => {
                  setSettingsVisible(false);
                  void signOut();
                }}
              >
                <Text style={styles.primaryButtonText}>Sign out</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal animationType="fade" transparent visible={modelPickerVisible} onRequestClose={() => setModelPickerVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.sheetCard}>
            <Text style={styles.modalTitle}>Choose model</Text>
            <Text style={styles.sheetSubtitle}>Pick the model for this chat.</Text>
            <ScrollView style={styles.modelList} contentContainerStyle={styles.modelListContent}>
              {models.map((model) => {
                const active = model.id === selectedChat?.model;
                return (
                  <Pressable
                    key={model.id}
                    style={[styles.modelOption, active && styles.modelOptionActive]}
                    onPress={() => handleSelectModel(model.id)}
                  >
                    <View style={styles.modelOptionText}>
                      <Text style={styles.modelOptionTitle}>{model.name}</Text>
                      <Text style={styles.modelOptionMeta}>
                        {model.supportsReasoning ? 'Supports reasoning' : 'Standard chat model'}
                      </Text>
                    </View>
                    {active ? <Text style={styles.modelOptionCheck}>✓</Text> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={styles.modalActions}>
              <Pressable style={styles.secondaryButton} onPress={() => setModelPickerVisible(false)}>
                <Text style={styles.secondaryButtonText}>Done</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    flexDirection: 'row',
    gap: 16,
  },
  shellCompact: {
    flexDirection: 'column',
  },
  centeredLayout: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  signInCard: {
    width: '100%',
    maxWidth: 560,
    backgroundColor: '#111827',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#263154',
    padding: 24,
    gap: 16,
  },
  eyebrow: {
    color: '#60a5fa',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    fontSize: 12,
    fontWeight: '700',
  },
  signInTitle: {
    color: '#f8fafc',
    fontSize: 30,
    lineHeight: 38,
    fontWeight: '800',
  },
  signInBody: {
    color: '#cbd5e1',
    fontSize: 16,
    lineHeight: 24,
  },
  sidebar: {
    width: 300,
    backgroundColor: '#0f172a',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#1e293b',
    padding: 16,
    gap: 16,
  },
  sidebarCompact: {
    width: '100%',
  },
  sidebarHeader: {
    gap: 4,
  },
  sidebarTitle: {
    color: '#f8fafc',
    fontSize: 19,
    fontWeight: '800',
  },
  sidebarSubtitle: {
    color: '#94a3b8',
    fontSize: 13,
  },
  sidebarScroll: {
    flex: 1,
  },
  sidebarContent: {
    gap: 18,
    paddingBottom: 16,
  },
  section: {
    gap: 12,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  sectionHint: {
    color: '#64748b',
    fontSize: 12,
  },
  sidebarList: {
    gap: 10,
  },
  sidebarItem: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#1f2b46',
    backgroundColor: '#111827',
    padding: 14,
    gap: 4,
  },
  sidebarItemActive: {
    borderColor: '#60a5fa',
    backgroundColor: '#162038',
  },
  sidebarItemTitle: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '700',
  },
  sidebarItemMeta: {
    color: '#94a3b8',
    fontSize: 13,
  },
  createProjectCard: {
    gap: 10,
    padding: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#1f2b46',
    backgroundColor: '#111827',
  },
  sidebarInput: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#263154',
    backgroundColor: '#020617',
    color: '#f8fafc',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  mainPanel: {
    flex: 1,
    backgroundColor: '#111827',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#1e293b',
    padding: 18,
    gap: 16,
    minHeight: 0,
  },
  mainHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  mainHeaderText: {
    flex: 1,
    gap: 6,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  chatTitle: {
    color: '#f8fafc',
    fontSize: 28,
    fontWeight: '800',
  },
  chatSubtitle: {
    color: '#94a3b8',
    fontSize: 14,
  },
  modelPillButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#0f172a',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  modelPillText: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600',
  },
  modelPillChevron: {
    color: '#94a3b8',
    fontSize: 12,
  },
  settingsButton: {
    width: 42,
    height: 42,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0f172a',
  },
  settingsButtonText: {
    color: '#f8fafc',
    fontSize: 20,
  },
  messagesScroll: {
    flex: 1,
    minHeight: 0,
  },
  messageList: {
    gap: 14,
    paddingBottom: 12,
  },
  composerCard: {
    gap: 12,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#1f2937',
    backgroundColor: '#0b1120',
    padding: 14,
  },
  composerInput: {
    minHeight: 92,
    maxHeight: 220,
    color: '#f8fafc',
    fontSize: 15,
    lineHeight: 22,
    textAlignVertical: 'top',
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  composerFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: 12,
  },
  composerMeta: {
    flex: 1,
    gap: 8,
  },
  composerTools: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  inlineModelButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#111827',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  inlineModelButtonText: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600',
  },
  helperText: {
    color: '#64748b',
    fontSize: 12,
  },
  draftAttachmentList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  draftAttachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#111827',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  draftAttachmentText: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '600',
    maxWidth: 220,
  },
  draftAttachmentRemove: {
    color: '#94a3b8',
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 16,
  },
  sendButton: {
    minWidth: 112,
  },
  primaryButton: {
    borderRadius: 14,
    backgroundColor: '#2563eb',
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  newChatButton: {
    borderRadius: 14,
    backgroundColor: '#2563eb',
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButton: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#0f172a',
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: '#cbd5e1',
    fontSize: 14,
    fontWeight: '700',
  },
  disabledButton: {
    opacity: 0.6,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  loadingText: {
    color: '#cbd5e1',
  },
  errorCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#7f1d1d',
    backgroundColor: '#371515',
    padding: 14,
  },
  errorText: {
    color: '#fecaca',
    fontSize: 14,
  },
  deviceAuthCard: {
    backgroundColor: '#141b34',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#263154',
    padding: 18,
    gap: 10,
  },
  deviceAuthLabel: {
    color: '#94a3b8',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  deviceAuthCode: {
    color: '#f8fafc',
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 2,
  },
  deviceAuthBody: {
    color: '#cbd5e1',
    lineHeight: 22,
  },
  deviceAuthLink: {
    color: '#93c5fd',
    fontWeight: '700',
  },
  deviceAuthMeta: {
    color: '#94a3b8',
    fontSize: 12,
  },
  configHint: {
    backgroundColor: '#221a12',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#7c5b19',
    padding: 16,
    gap: 8,
  },
  configHintTitle: {
    color: '#fef3c7',
    fontSize: 16,
    fontWeight: '700',
  },
  configHintBody: {
    color: '#fde68a',
    fontSize: 14,
    lineHeight: 20,
  },
  configHintCode: {
    color: '#f8fafc',
    fontWeight: '700',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#111827',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#263154',
    padding: 20,
    gap: 16,
  },
  sheetCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#111827',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#263154',
    padding: 20,
    gap: 16,
  },
  modalTitle: {
    color: '#f8fafc',
    fontSize: 22,
    fontWeight: '800',
  },
  modalBody: {
    color: '#cbd5e1',
    fontSize: 15,
  },
  sheetSubtitle: {
    color: '#94a3b8',
    fontSize: 14,
  },
  modelList: {
    maxHeight: 320,
  },
  modelListContent: {
    gap: 10,
  },
  modelOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#263154',
    backgroundColor: '#0f172a',
    padding: 14,
  },
  modelOptionActive: {
    borderColor: '#60a5fa',
    backgroundColor: '#162038',
  },
  modelOptionText: {
    flex: 1,
    gap: 4,
  },
  modelOptionTitle: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '700',
  },
  modelOptionMeta: {
    color: '#94a3b8',
    fontSize: 13,
  },
  modelOptionCheck: {
    color: '#60a5fa',
    fontSize: 18,
    fontWeight: '800',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
});
