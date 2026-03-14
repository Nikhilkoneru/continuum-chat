import type { ChatMessage } from '@github-personal-assistant/shared';

type MessageBubbleProps = {
  message: ChatMessage;
  isStreaming?: boolean;
};

const formatTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isError = message.role === 'error';
  const isAssistant = message.role === 'assistant';
  const isPending = isAssistant && !message.content && !message.metadata?.reasoning;

  const reasoningState = message.metadata?.reasoningState as 'streaming' | 'complete' | undefined;
  const isThinking = reasoningState === 'streaming';
  const hasReasoning = Boolean(message.metadata?.reasoning);
  const toolActivities = message.metadata?.toolActivities;
  const usage = message.metadata?.usage;

  const usageParts: string[] = [];
  if (usage?.inputTokens) usageParts.push(`${usage.inputTokens.toLocaleString()} in`);
  if (usage?.outputTokens) usageParts.push(`${usage.outputTokens.toLocaleString()} out`);
  if (typeof usage?.duration === 'number') usageParts.push(`${(usage.duration / 1000).toFixed(1)}s`);

  return (
    <div className={`msg${isUser ? ' msg--user' : ''}${isError ? ' msg--error' : ''}`}>
      {!isUser ? (
        <div className="msg-avatar">
          <svg className="msg-avatar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2a7 7 0 0 0-4.5 12.35V22l4.5-2.5 4.5 2.5v-7.65A7 7 0 0 0 12 2z" />
          </svg>
        </div>
      ) : null}
      <div className="msg-body">
        {(isThinking || (isPending && isStreaming)) ? (
          <div className="thinking-live">
            <div className="thinking-pulse" />
            <div>
              <span className="thinking-label">{isThinking ? 'Thinking…' : 'Working…'}</span>
              {isThinking && message.metadata?.reasoning ? (
                <div className="thinking-preview">{message.metadata.reasoning}</div>
              ) : null}
            </div>
          </div>
        ) : null}

        {hasReasoning && !isThinking ? (
          <details className="reasoning-block">
            <summary className="reasoning-toggle">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm6.5-.25A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.75h.25a.75.75 0 010 1.5h-2a.75.75 0 010-1.5h.25v-2h-.25a.75.75 0 01-.75-.75zM8 6a1 1 0 110-2 1 1 0 010 2z" />
              </svg>
              Reasoning
            </summary>
            <div className="reasoning-text">{message.metadata!.reasoning}</div>
          </details>
        ) : null}

        {message.content ? <div className="msg-content">{message.content}</div> : null}

        {toolActivities?.length ? (
          <div className="tool-chips">
            {toolActivities.map((activity) => (
              <span key={activity.id} className={`tool-chip tool-chip--${activity.status}`}>
                {activity.toolName}
                {activity.status === 'running' ? <span className="tool-chip-dot" /> : null}
              </span>
            ))}
          </div>
        ) : null}

        {message.attachments?.length ? (
          <div className="msg-attachments">
            {message.attachments.map((attachment) => (
              <span key={attachment.id} className="msg-attachment">{attachment.name}</span>
            ))}
          </div>
        ) : null}

        <div className="msg-footer">
          <time className="msg-time">{formatTime(message.createdAt)}</time>
          {usageParts.length ? <span className="msg-usage">{usageParts.join(' · ')}</span> : null}
        </div>
      </div>
    </div>
  );
}
