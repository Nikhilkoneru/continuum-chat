export type AppSessionUser = {
  id: number;
  login: string;
  name?: string | null;
  avatarUrl?: string;
};

export type UserSession = {
  sessionToken: string;
  user: AppSessionUser;
};

export type ApiHealth = {
  status: 'ok';
  copilotConfigured: boolean;
  authConfigured: boolean;
};

export type GitHubDeviceAuthStart = {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: string;
  interval: number;
};

export type GitHubDeviceAuthPoll =
  | ({ status: 'pending' } & GitHubDeviceAuthStart)
  | { status: 'complete'; session: UserSession }
  | { status: 'denied' | 'expired'; error: string };

export type ModelOption = {
  id: string;
  name: string;
  source: 'sdk' | 'static';
  supportsReasoning?: boolean;
  premium?: boolean;
};

export type AttachmentKind = 'image' | 'document' | 'audio' | 'video' | 'other';

export type AttachmentSummary = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  uploadedAt: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  defaultModel: string;
  updatedAt: string;
};

export type ProjectDetail = ProjectSummary & {
  instructions: string;
};

export type ChatRole = 'user' | 'assistant' | 'system' | 'error';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  attachments?: AttachmentSummary[];
};

export type ChatStreamInput = {
  projectId?: string;
  prompt: string;
  model?: string;
  sessionId?: string;
  attachments?: string[];
};

export type ChatStreamEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'chunk'; delta: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
