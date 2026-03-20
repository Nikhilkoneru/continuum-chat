import { useState, useRef, useCallback, useEffect, type CSSProperties } from 'react';

import type { CanvasArtifact, CanvasSelection } from '../lib/types.js';
import { MarkdownContent } from './markdown-content.js';

type CanvasPaneProps = {
  canvases: CanvasArtifact[];
  activeCanvasId: string | null;
  canvas: CanvasArtifact | null;
  selection: CanvasSelection | null;
  selectionPromptDraft: string;
  saving?: boolean;
  onClose: () => void;
  onCreateCanvas?: () => void;
  onSelectCanvas: (canvasId: string) => void;
  onTitleChange: (canvasId: string, title: string) => void;
  onContentChange: (canvasId: string, content: string) => void;
  onContentBlur: (canvasId: string, title: string, content: string) => void;
  onSelectionChange: (canvasId: string, selection: CanvasSelection | null) => void;
  onSelectionPromptChange: (value: string) => void;
  onSubmitSelectionPrompt: () => void;
  onClearSelection: () => void;
  onCopy: (canvas: CanvasArtifact) => void;
  selectionSubmitDisabled?: boolean;
};

type InlineComposerPosition = {
  left: number;
  top: number;
};

const INLINE_COMPOSER_MAX_WIDTH = 320;
const INLINE_COMPOSER_HEIGHT = 56;
const MIRROR_STYLE_PROPERTIES = [
  'box-sizing',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'font-family',
  'font-size',
  'font-style',
  'font-variant',
  'font-weight',
  'letter-spacing',
  'line-height',
  'tab-size',
  'text-indent',
  'text-rendering',
  'text-transform',
  'word-spacing',
] as const;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const getTextareaSelectionAnchor = (textarea: HTMLTextAreaElement, position: number) => {
  if (typeof document === 'undefined' || textarea.clientWidth === 0) {
    return null;
  }

  const computed = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  mirror.style.position = 'absolute';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.wordBreak = 'break-word';
  mirror.style.width = `${textarea.clientWidth}px`;

  for (const property of MIRROR_STYLE_PROPERTIES) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }

  const beforeSelection = textarea.value.slice(0, position);
  mirror.textContent = beforeSelection;
  if (beforeSelection.endsWith('\n')) {
    mirror.textContent += '\u200b';
  }

  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(position, position + 1) || '\u200b';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const anchor = {
    left: marker.offsetLeft - textarea.scrollLeft,
    top: marker.offsetTop - textarea.scrollTop,
    lineHeight: Number.parseFloat(computed.lineHeight) || marker.offsetHeight || 20,
  };

  document.body.removeChild(mirror);
  return anchor;
};

function SendSelectionIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4Z" />
    </svg>
  );
}

export function CanvasPane({
  canvases,
  activeCanvasId,
  canvas,
  selection,
  selectionPromptDraft,
  saving,
  onClose,
  onCreateCanvas,
  onSelectCanvas,
  onTitleChange,
  onContentChange,
  onContentBlur,
  onSelectionChange,
  onSelectionPromptChange,
  onSubmitSelectionPrompt,
  onClearSelection,
  onCopy,
  selectionSubmitDisabled,
}: CanvasPaneProps) {
  const [editing, setEditing] = useState(false);
  const [inlineComposerPosition, setInlineComposerPosition] = useState<InlineComposerPosition | null>(null);
  const canvasDocumentRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const selectionComposerRef = useRef<HTMLDivElement>(null);
  const selectionPromptRef = useRef<HTMLInputElement>(null);

  const enterEditMode = useCallback(() => {
    setEditing(true);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, []);

  const exitEditMode = useCallback(() => {
    if (canvas) {
      onContentBlur(canvas.id, canvas.title, canvas.content);
    }
    setEditing(false);
  }, [canvas, onContentBlur]);

  const updateInlineComposerPosition = useCallback(() => {
    const textarea = editorRef.current;
    const container = canvasDocumentRef.current;
    if (!textarea || !container || !selection) {
      setInlineComposerPosition(null);
      return;
    }

    const anchor = getTextareaSelectionAnchor(textarea, selection.end);
    if (!anchor) {
      setInlineComposerPosition(null);
      return;
    }

    const rawLeft = textarea.offsetLeft + anchor.left;
    const maxLeft = Math.max(12, container.clientWidth - INLINE_COMPOSER_MAX_WIDTH - 12);
    const left = clamp(rawLeft, 12, maxLeft);

    const belowTop = textarea.offsetTop + anchor.top + anchor.lineHeight + 10;
    const aboveTop = textarea.offsetTop + anchor.top - INLINE_COMPOSER_HEIGHT - 10;
    const visibleTop = container.scrollTop + 12;
    const visibleBottom = container.scrollTop + container.clientHeight - INLINE_COMPOSER_HEIGHT - 12;
    const top = belowTop <= visibleBottom ? belowTop : Math.max(visibleTop, aboveTop);

    setInlineComposerPosition({ left, top });
  }, [selection]);

  const dismissSelection = useCallback(
    (options?: { refocusEditor?: boolean }) => {
      onClearSelection();
      if (options?.refocusEditor) {
        requestAnimationFrame(() => editorRef.current?.focus());
      }
    },
    [onClearSelection],
  );

  const handleEditorBlur = useCallback(() => {
    requestAnimationFrame(() => {
      const activeElement = document.activeElement;
      if (selectionComposerRef.current?.contains(activeElement)) {
        return;
      }
      exitEditMode();
    });
  }, [exitEditMode]);

  const handleInlineComposerBlur = useCallback(() => {
    requestAnimationFrame(() => {
      const activeElement = document.activeElement;
      if (selectionComposerRef.current?.contains(activeElement)) {
        return;
      }
      if (activeElement === editorRef.current) {
        return;
      }
      onClearSelection();
      exitEditMode();
    });
  }, [exitEditMode, onClearSelection]);

  useEffect(() => {
    setEditing(false);
    setInlineComposerPosition(null);
  }, [canvas?.id]);

  useEffect(() => {
    if (!editing || !selection) {
      setInlineComposerPosition(null);
      return;
    }

    updateInlineComposerPosition();
    const textarea = editorRef.current;
    const container = canvasDocumentRef.current;
    if (!textarea || !container) {
      return;
    }

    const handleViewportChange = () => updateInlineComposerPosition();
    textarea.addEventListener('scroll', handleViewportChange);
    container.addEventListener('scroll', handleViewportChange);
    window.addEventListener('resize', handleViewportChange);
    return () => {
      textarea.removeEventListener('scroll', handleViewportChange);
      container.removeEventListener('scroll', handleViewportChange);
      window.removeEventListener('resize', handleViewportChange);
    };
  }, [canvas?.content, editing, selection, updateInlineComposerPosition]);

  useEffect(() => {
    if (!selection || !editing || !inlineComposerPosition) {
      return;
    }
    requestAnimationFrame(() => {
      selectionPromptRef.current?.focus();
    });
  }, [editing, inlineComposerPosition, selection, canvas?.id]);

  const inlineComposerStyle: CSSProperties | undefined = inlineComposerPosition
    ? {
        left: `${inlineComposerPosition.left}px`,
        top: `${inlineComposerPosition.top}px`,
      }
    : undefined;

  return (
    <aside className="canvas-pane">
      <div className="canvas-header">
        <button type="button" className="canvas-header-btn" onClick={onClose} aria-label="Close canvas" title="Close">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>
        </button>

        <div className="canvas-header-center">
          {canvas ? (
            <span className="canvas-header-title">{canvas.title}</span>
          ) : null}
          {saving ? <span className="canvas-saving-dot" title="Saving…" /> : null}
        </div>

        <div className="canvas-header-actions">
          {canvas ? (
            <>
              {onCreateCanvas ? (
                <button type="button" className="canvas-header-btn" onClick={onCreateCanvas} aria-label="Create canvas" title="New canvas">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8.75 1.75a.75.75 0 0 0-1.5 0v5.5h-5.5a.75.75 0 0 0 0 1.5h5.5v5.5a.75.75 0 0 0 1.5 0v-5.5h5.5a.75.75 0 0 0 0-1.5h-5.5v-5.5z"/></svg>
                </button>
              ) : null}
              <button type="button" className="canvas-header-btn" onClick={() => onCopy(canvas)} aria-label="Copy" title="Copy content">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>
              </button>
            </>
          ) : null}
        </div>
      </div>

      {canvases.length ? (
        <div className="canvas-strip" role="tablist" aria-label="Thread canvases">
          {canvases.map((item) => {
            const isActive = item.id === activeCanvasId;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`canvas-strip-item${isActive ? ' canvas-strip-item--active' : ''}`}
                onClick={() => onSelectCanvas(item.id)}
              >
                <span className="canvas-strip-item-title">{item.title}</span>
                <span className="canvas-strip-item-meta">{item.kind}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {canvas ? (
        <div ref={canvasDocumentRef} className="canvas-document">
          {editing ? (
            <>
              <textarea
                ref={editorRef}
                className="canvas-editor"
                value={canvas.content}
                onChange={(event) => onContentChange(canvas.id, event.target.value)}
                onBlur={handleEditorBlur}
                onSelect={(event) => {
                  const target = event.currentTarget;
                  const start = target.selectionStart ?? 0;
                  const end = target.selectionEnd ?? 0;
                  if (end <= start) {
                    onSelectionChange(canvas.id, null);
                    return;
                  }
                  onSelectionChange(canvas.id, { start, end, text: target.value.slice(start, end) });
                }}
                spellCheck={canvas.kind !== 'code'}
                aria-label={`Editing ${canvas.title}`}
              />

              {selection && inlineComposerStyle ? (
                <div
                  ref={selectionComposerRef}
                  className="canvas-selection-inline"
                  style={inlineComposerStyle}
                >
                  <input
                    ref={selectionPromptRef}
                    className="canvas-selection-inline-input"
                    value={selectionPromptDraft}
                    onChange={(event) => onSelectionPromptChange(event.target.value)}
                    onBlur={handleInlineComposerBlur}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        onSubmitSelectionPrompt();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        dismissSelection({ refocusEditor: true });
                      }
                    }}
                    placeholder="Edit selected text…"
                    aria-label={`Edit selected text in ${canvas.title}`}
                  />
                  <button
                    type="button"
                    className="canvas-selection-inline-send"
                    onClick={onSubmitSelectionPrompt}
                    disabled={selectionSubmitDisabled || !selectionPromptDraft.trim()}
                    aria-label="Apply selection edit"
                    title="Apply selection edit"
                  >
                    <SendSelectionIcon />
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="canvas-rendered" onClick={enterEditMode} role="button" tabIndex={0} aria-label="Click to edit">
              <MarkdownContent content={canvas.content} className="canvas-markdown" />
            </div>
          )}
        </div>
      ) : (
        <div className="canvas-empty canvas-empty--editor">
          Ask the assistant to create or update a canvas, then edit it here like a document.
        </div>
      )}

      {canvas && !editing ? (
        <button type="button" className="canvas-fab" onClick={enterEditMode} aria-label="Edit document" title="Edit">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L3.463 11.098a.25.25 0 00-.064.108l-.563 1.97 1.971-.564a.25.25 0 00.108-.064l8.61-8.61a.25.25 0 000-.354L12.427 2.487z"/></svg>
        </button>
      ) : null}
    </aside>
  );
}
