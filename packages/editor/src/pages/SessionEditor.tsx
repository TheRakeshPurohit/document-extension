import React, { useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  getSession,
  updateSteps,
  updateSessionTitle,
  deleteSession,
  mergeSteps,
  keepSeparate,
} from '../api/client.js';
import StepCard from '../components/StepCard.js';
import MergePromptCard from '../components/MergePromptCard.js';
import ExportPanel from '../components/ExportPanel.js';
import ScreenshotViewer from '../components/ScreenshotViewer.js';
import ConfirmModal from '../components/ConfirmModal.js';
import type { Step } from '@docext/shared';

export default function SessionEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [viewScreenshot, setViewScreenshot] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  // Keep a local mirror of steps so edits are instant
  const [localSteps, setLocalSteps] = useState<Step[] | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['session', id],
    queryFn: () => getSession(id!),
    enabled: !!id,
  });

  const serverSteps = data?.steps ?? [];
  const steps = localSteps ?? serverSteps;

  const mutationCountRef = useRef(0);

  const updateMutation = useMutation({
    mutationFn: (args: { steps: Step[]; deletedStepIds?: string[] }) =>
      updateSteps(id!, {
        steps: args.steps.map((s, i) => ({
          id: s.id,
          sortOrder: i,
          title: s.title,
          description: s.description,
        })),
        deletedStepIds: args.deletedStepIds,
      }),
    onSuccess: (result) => {
      mutationCountRef.current--;
      queryClient.setQueryData(['session', id], (old: typeof data) =>
        old ? { ...old, steps: result.steps } : old
      );
      if (mutationCountRef.current === 0) setLocalSteps(null);
      setSaveError(null);
    },
    onError: (err) => {
      mutationCountRef.current--;
      console.error('Step update failed:', err);
      setSaveError('Failed to save — try again');
      if (mutationCountRef.current === 0) setLocalSteps(null);
    },
  });

  const { mutate } = updateMutation;

  const flushUpdate = useCallback((args: { steps: Step[]; deletedStepIds?: string[] }) => {
    mutationCountRef.current++;
    setLocalSteps(args.steps);
    mutate(args);
  }, [mutate]);

  const titleMutation = useMutation({
    mutationFn: (title: string) => updateSessionTitle(id!, title),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['session', id] }),
    onError: (err) => {
      console.error('Title update failed:', err);
      setSaveError('Failed to save title');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteSession(id!),
    onSuccess: () => navigate('/'),
    onError: (err) => {
      console.error('Delete failed:', err);
      setSaveError('Failed to delete session');
    },
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const current = stepsRef.current;
      const oldIndex = current.findIndex((s) => s.id === active.id);
      const newIndex = current.findIndex((s) => s.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = [...current];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);

      flushUpdate({ steps: reordered });
    },
    [flushUpdate]
  );

  const handleStepUpdate = useCallback(
    (stepId: string, field: 'title' | 'description', value: string) => {
      const updated = stepsRef.current.map((s) =>
        s.id === stepId ? { ...s, [field]: value } : s
      );
      flushUpdate({ steps: updated });
    },
    [flushUpdate]
  );

  const handleStepDelete = useCallback(
    (stepId: string) => {
      const remaining = stepsRef.current.filter((s) => s.id !== stepId);
      flushUpdate({ steps: remaining, deletedStepIds: [stepId] });
    },
    [flushUpdate]
  );

  const handleScreenshotClick = useCallback(
    (screenshotId: string) => setViewScreenshot(screenshotId),
    []
  );

  const handleCloseViewer = useCallback(() => setViewScreenshot(null), []);

  const handleMergeGroup = useCallback(
    async (groupIds: string[]) => {
      const result = await mergeSteps(id!, groupIds);
      queryClient.setQueryData(['session', id], (old: typeof data) =>
        old ? { ...old, steps: result.steps } : old
      );
      setLocalSteps(null);
    },
    [id, queryClient]
  );

  const handleKeepSeparate = useCallback(
    async (groupIds: string[]) => {
      const result = await keepSeparate(id!, groupIds);
      queryClient.setQueryData(['session', id], (old: typeof data) =>
        old ? { ...old, steps: result.steps } : old
      );
      setLocalSteps(null);
    },
    [id, queryClient]
  );

  const handleTitleSave = () => {
    if (titleDraft.trim()) {
      titleMutation.mutate(titleDraft.trim());
    }
    setEditingTitle(false);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-slate-500 text-sm">Loading session...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-red-400 text-sm">Session not found or failed to load.</div>
      </div>
    );
  }

  const { session } = data;

  return (
    <div className="max-w-3xl mx-auto">
      {/* Save error banner */}
      {saveError && (
        <div className="mb-4 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-center justify-between">
          <span>{saveError}</span>
          <button
            onClick={() => setSaveError(null)}
            className="text-red-500 hover:text-red-700 bg-transparent border-none cursor-pointer ml-4"
          >
            ✕
          </button>
        </div>
      )}

      {/* Header */}
      <div className="mb-8 bg-white/80 border border-slate-200 rounded-2xl p-6 shadow-sm backdrop-blur">
        <button
          onClick={() => navigate('/')}
          className="text-slate-600 hover:text-slate-800 text-sm mb-4 inline-flex items-center gap-1 bg-transparent border-none cursor-pointer p-0"
        >
          ← Back to sessions
        </button>

        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleTitleSave();
                  if (e.key === 'Escape') setEditingTitle(false);
                }}
                className="text-2xl font-bold bg-white text-slate-900 border border-slate-300 rounded-lg px-3 py-1 w-full outline-none focus:border-indigo-500"
              />
            ) : (
              <h1
                className="text-2xl font-bold cursor-pointer hover:text-indigo-600 transition-colors"
                onClick={() => {
                  setTitleDraft(session.title);
                  setEditingTitle(true);
                }}
                title="Click to edit title"
              >
                {session.title}
              </h1>
            )}
            <div className="flex items-center gap-3 mt-1.5">
              <p className="text-sm text-slate-500">
                {new Date(session.createdAt).toLocaleString()} · {steps.length} step{steps.length !== 1 ? 's' : ''}
              </p>
              {updateMutation.isPending && (
                <span className="text-xs text-indigo-600">Saving...</span>
              )}
            </div>
          </div>

          <div className="flex gap-2 flex-shrink-0 pt-1">
            <ExportPanel sessionId={id!} />
            <button
              onClick={() => setShowDeleteModal(true)}
              className="px-3 py-2 bg-red-600 hover:bg-red-500 text-white border border-red-500 rounded-lg text-sm transition-colors cursor-pointer"
            >
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* Steps */}
      {steps.length === 0 ? (
        <div className="border border-dashed border-slate-200 rounded-xl p-12 text-center bg-white/60">
          <p className="text-slate-500">No steps generated yet</p>
          <p className="text-slate-600 text-sm mt-1">Steps are generated when a recording is finalized.</p>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={steps.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-6">
              {(() => {
                const elements: React.ReactNode[] = [];
                const rendered = new Set<string>();

                // Walk steps sequentially.  At each step that heads a merge chain
                // emit: Card(A), Card(B), PairPrompt([A,B]),
                //       Card(C)?, ExtendPrompt([A,B,C])? — one prompt per boundary.
                let i = 0;
                while (i < steps.length) {
                  const step = steps[i];

                  if (rendered.has(step.id)) { i++; continue; }

                  rendered.add(step.id);
                  elements.push(
                    <StepCard
                      key={step.id}
                      step={step}
                      index={i}
                      onUpdate={handleStepUpdate}
                      onDelete={handleStepDelete}
                      onScreenshotClick={handleScreenshotClick}
                    />
                  );

                  // Does this step link to a next mergeable step?
                  if (step.mergeWithNextId) {
                    const nextStep = steps.find((s) => s.id === step.mergeWithNextId);
                    if (nextStep && !rendered.has(nextStep.id)) {
                      const nextIndex = steps.indexOf(nextStep);

                      rendered.add(nextStep.id);
                      elements.push(
                        <StepCard
                          key={nextStep.id}
                          step={nextStep}
                          index={nextIndex}
                          onUpdate={handleStepUpdate}
                          onDelete={handleStepDelete}
                          onScreenshotClick={handleScreenshotClick}
                        />
                      );

                      // Pair prompt: "Steps A & B happened together — merge?"
                      elements.push(
                        <MergePromptCard
                          key={`mp-pair-${step.id}`}
                          sessionId={id!}
                          mergeGroup={[step, nextStep]}
                          keepSeparateIds={[step.id, nextStep.id]}
                          mode="pair"
                          onMerge={handleMergeGroup}
                          onKeepSeparate={handleKeepSeparate}
                        />
                      );

                      // Does the second step also link to a third?
                      if (nextStep.mergeWithNextId) {
                        const thirdStep = steps.find((s) => s.id === nextStep.mergeWithNextId);
                        if (thirdStep && !rendered.has(thirdStep.id)) {
                          const thirdIndex = steps.indexOf(thirdStep);

                          rendered.add(thirdStep.id);
                          elements.push(
                            <StepCard
                              key={thirdStep.id}
                              step={thirdStep}
                              index={thirdIndex}
                              onUpdate={handleStepUpdate}
                              onDelete={handleStepDelete}
                              onScreenshotClick={handleScreenshotClick}
                            />
                          );

                          // Extend prompt: "Also add step 3 into the group above?"
                          // Merges all 3; keep-separate only unlinks the B→C link.
                          elements.push(
                            <MergePromptCard
                              key={`mp-ext-${step.id}`}
                              sessionId={id!}
                              mergeGroup={[step, nextStep, thirdStep]}
                              keepSeparateIds={[nextStep.id, thirdStep.id]}
                              mode="extend"
                              onMerge={handleMergeGroup}
                              onKeepSeparate={handleKeepSeparate}
                            />
                          );
                        }
                      }
                    }
                  }

                  i++;
                }

                return elements;
              })()}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {viewScreenshot && (
        <ScreenshotViewer
          screenshotId={viewScreenshot}
          onClose={handleCloseViewer}
        />
      )}

      <ConfirmModal
        open={showDeleteModal}
        title="Delete Session"
        message="Delete this session permanently? This action cannot be undone."
        confirmLabel={deleteMutation.isPending ? 'Deleting...' : 'Delete'}
        onCancel={() => setShowDeleteModal(false)}
        onConfirm={() => {
          if (deleteMutation.isPending) return;
          setShowDeleteModal(false);
          deleteMutation.mutate();
        }}
      />
    </div>
  );
}
