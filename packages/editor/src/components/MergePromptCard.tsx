import React, { useState } from 'react';
import type { Step } from '@docext/shared';

interface MergePromptCardProps {
  sessionId: string;
  /** All steps that will be merged if the user clicks Merge */
  mergeGroup: Step[];
  /** Step IDs whose mergeWithNextId should be cleared when "Keep separate" is clicked.
   *  For a pair prompt [A,B]: both A and B.
   *  For an "extend" prompt (step C joining A+B): only [B,C] — the A→B link stays. */
  keepSeparateIds: string[];
  /** 'pair'   — "Steps 1 & 2 happened together — merge?"
   *  'extend' — "Also add step 3 into the group above?" */
  mode: 'pair' | 'extend';
  onMerge: (groupIds: string[]) => Promise<void>;
  onKeepSeparate: (groupIds: string[]) => Promise<void>;
}

export default function MergePromptCard({
  mergeGroup,
  keepSeparateIds,
  mode,
  onMerge,
  onKeepSeparate,
}: MergePromptCardProps) {
  const [loading, setLoading] = useState<'merge' | 'keep' | null>(null);

  const label =
    mode === 'extend'
      ? 'Also add this step into the group above?'
      : 'These steps happened together — merge into one?';

  const handleMerge = async () => {
    setLoading('merge');
    try {
      await onMerge(mergeGroup.map((s) => s.id));
    } finally {
      setLoading(null);
    }
  };

  const handleKeep = async () => {
    setLoading('keep');
    try {
      await onKeepSeparate(keepSeparateIds);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm">
      <span className="text-amber-600 text-base leading-none flex-shrink-0">⚡</span>
      <span className="text-amber-800 flex-1">{label}</span>
      <button
        onClick={handleMerge}
        disabled={!!loading}
        className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer border-none"
      >
        {loading === 'merge' ? 'Merging…' : 'Merge'}
      </button>
      <button
        onClick={handleKeep}
        disabled={!!loading}
        className="px-3 py-1.5 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-700 text-xs font-semibold rounded-lg border border-slate-300 transition-colors cursor-pointer"
      >
        {loading === 'keep' ? 'Saving…' : 'Keep separate'}
      </button>
    </div>
  );
}
