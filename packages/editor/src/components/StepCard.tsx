import React, { useState, memo, useMemo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getScreenshotUrl } from '../api/client.js';
import type { Step } from '@docext/shared';

interface StepCardProps {
  step: Step;
  index: number;
  onUpdate: (stepId: string, field: 'title' | 'description', value: string) => void;
  onDelete: (stepId: string) => void;
  onScreenshotClick: (screenshotId: string) => void;
}

type FrameTab = 'annotated' | 'clean' | 'result';
type ThemeTab = 'light' | 'dark' | 'both';

export default memo(function StepCard({
  step,
  index,
  onUpdate,
  onDelete,
  onScreenshotClick,
}: StepCardProps) {
  const [editingField, setEditingField] = useState<'title' | 'description' | null>(null);
  const [draft, setDraft] = useState('');
  const [frame, setFrame] = useState<FrameTab>('annotated');
  const [theme, setTheme] = useState<ThemeTab>(
    step.themeCapture === 'same' || !step.altScreenshotId ? 'light' : 'both',
  );

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const hasClean = !!(step.beforeLightId || step.beforeDarkId);
  const hasResult = !!(step.afterLightId || step.afterDarkId);
  const showDark = step.themeCapture !== 'same';

  const pair = useMemo(() => {
    if (frame === 'clean') {
      return {
        light: step.beforeLightId || step.screenshotId,
        dark: showDark ? (step.beforeDarkId || step.altScreenshotId) : undefined,
      };
    }
    if (frame === 'result') {
      return {
        light: step.afterLightId,
        dark: showDark ? step.afterDarkId : undefined,
      };
    }
    return {
      light: step.screenshotId,
      dark: showDark ? step.altScreenshotId : undefined,
    };
  }, [frame, step, showDark]);

  const startEditing = (field: 'title' | 'description') => {
    setDraft(field === 'title' ? step.title : step.description);
    setEditingField(field);
  };

  const saveEditing = () => {
    if (editingField && draft !== step[editingField]) {
      onUpdate(step.id, editingField, draft);
    }
    setEditingField(null);
  };

  const tabBtn = (active: boolean) =>
    `px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border transition-colors ${
      active
        ? 'bg-indigo-500 text-white border-indigo-500'
        : 'bg-white/80 text-slate-600 border-slate-200 hover:border-indigo-300'
    }`;

  const renderShot = (id: string | undefined, label: string) => {
    if (!id) return null;
    return (
      <div className="cursor-pointer relative" onClick={() => onScreenshotClick(id)}>
        {pair.dark && theme === 'both' && (
          <span className="absolute top-2 left-2 bg-white/80 text-[10px] text-slate-700 px-1.5 py-0.5 rounded font-medium tracking-wide uppercase border border-slate-200 z-10">
            {label}
          </span>
        )}
        <img
          src={getScreenshotUrl(id)}
          alt={`Step ${index + 1} ${label}`}
          className="w-full max-h-[400px] object-contain"
          loading="lazy"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      </div>
    );
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group relative bg-white/80 border border-slate-200 rounded-2xl overflow-hidden hover:border-indigo-400/40 hover:shadow-[0_8px_30px_rgba(99,102,241,0.10)] transition-all"
    >
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200/60 bg-white/60">
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-slate-500 hover:text-slate-700 select-none text-lg leading-none"
          title="Drag to reorder"
        >
          ⠿
        </div>

        <span className="w-6 h-6 rounded-full bg-indigo-500/15 text-indigo-600 text-xs font-bold flex items-center justify-center flex-shrink-0">
          {index + 1}
        </span>

        <div className="flex-1 min-w-0">
          {editingField === 'title' ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={saveEditing}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveEditing();
                if (e.key === 'Escape') setEditingField(null);
              }}
              className="w-full bg-white text-slate-900 border border-slate-300 rounded-md px-2 py-1 text-sm font-semibold outline-none focus:border-indigo-500"
            />
          ) : (
            <div
              role="button"
              tabIndex={0}
              className="font-semibold text-sm text-slate-900 cursor-pointer hover:text-indigo-600 transition-colors truncate"
              onClick={() => startEditing('title')}
              onKeyDown={(e) => { if (e.key === 'Enter') startEditing('title'); }}
              title="Click to edit"
            >
              {step.title || 'Untitled step'}
            </div>
          )}
        </div>

        <button
          onClick={() => onDelete(step.id)}
          className="text-red-600 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all bg-transparent border-none cursor-pointer p-1 text-sm"
          title="Delete step"
        >
          ✕
        </button>
      </div>

      {/* Frame / theme tabs */}
      {(pair.light || hasClean || hasResult) && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-slate-200/60 bg-slate-50/80">
          <div className="flex gap-1">
            <button type="button" className={tabBtn(frame === 'annotated')} onClick={() => setFrame('annotated')}>
              Annotated
            </button>
            <button
              type="button"
              className={tabBtn(frame === 'clean')}
              onClick={() => setFrame('clean')}
              disabled={!hasClean && !step.screenshotId}
            >
              Clean
            </button>
            <button
              type="button"
              className={tabBtn(frame === 'result')}
              onClick={() => setFrame('result')}
              disabled={!hasResult}
              title={hasResult ? 'After-click result' : 'No after-click capture'}
            >
              Result
            </button>
          </div>
          {showDark && (pair.dark || step.altScreenshotId) && (
            <div className="flex gap-1 ml-auto">
              <button type="button" className={tabBtn(theme === 'light')} onClick={() => setTheme('light')}>
                Light
              </button>
              <button type="button" className={tabBtn(theme === 'dark')} onClick={() => setTheme('dark')}>
                Dark
              </button>
              <button type="button" className={tabBtn(theme === 'both')} onClick={() => setTheme('both')}>
                Both
              </button>
            </div>
          )}
        </div>
      )}

      {pair.light && (
        <div
          className={`bg-slate-100 ${
            theme === 'both' && pair.dark ? 'grid grid-cols-2 gap-px' : ''
          }`}
        >
          {(theme === 'light' || theme === 'both') && renderShot(pair.light, 'Light')}
          {(theme === 'dark' || theme === 'both') && pair.dark && renderShot(pair.dark, 'Dark')}
          {theme === 'dark' && !pair.dark && renderShot(pair.light, 'Light')}
        </div>
      )}

      {step.subSteps && step.subSteps.length > 0 && (
        <div className="px-4 py-3 border-b border-slate-200/60">
          <ol className="space-y-1.5">
            {step.subSteps.map((sub, subIdx) => (
              <li key={subIdx} className="flex items-start gap-2 text-sm">
                <span className="w-5 h-5 rounded-full bg-orange-500 text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                  {subIdx + 1}
                </span>
                <span className="text-slate-700">{sub.title}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="px-4 py-3">
        {editingField === 'description' ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={saveEditing}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditingField(null);
            }}
            rows={2}
            className="w-full bg-white text-slate-700 border border-slate-300 rounded-md px-2 py-1.5 text-sm outline-none focus:border-indigo-500 resize-none"
          />
        ) : (
          <div
            role="button"
            tabIndex={0}
            className="text-sm text-slate-600 cursor-pointer hover:text-slate-700 transition-colors"
            onClick={() => startEditing('description')}
            onKeyDown={(e) => { if (e.key === 'Enter') startEditing('description'); }}
            title="Click to add description"
          >
            {step.description || 'Add a description...'}
          </div>
        )}
      </div>
    </div>
  );
});
