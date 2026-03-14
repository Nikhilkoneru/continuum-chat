import crypto from 'node:crypto';

import type { ProjectDetail } from '@github-personal-assistant/shared';

import { env } from '../config';

const projectsByOwner = new Map<string, ProjectDetail[]>();

const createSeedProjects = (): ProjectDetail[] => {
  const now = new Date().toISOString();

  return [
    {
      id: 'launchpad',
      name: 'Launchpad',
      description: 'Product strategy, architecture, and launch planning for Github Personal Assistant.',
      defaultModel: env.defaultModel,
      updatedAt: now,
      instructions:
        'You are the launchpad assistant for Github Personal Assistant. Prioritize product strategy, delivery sequencing, and pragmatic implementation details.',
    },
    {
      id: 'mobile-foundation',
      name: 'Mobile foundation',
      description: 'Expo client work for web and Android, including UX, auth, and streaming chat.',
      defaultModel: env.defaultModel,
      updatedAt: now,
      instructions:
        'You are helping implement the Expo client. Prioritize mobile-friendly UX, performance, and platform-safe decisions.',
    },
  ];
};

const ensureProjects = (ownerId: string) => {
  if (!projectsByOwner.has(ownerId)) {
    projectsByOwner.set(ownerId, createSeedProjects());
  }

  return projectsByOwner.get(ownerId)!;
};

export const listProjects = (ownerId: string) => ensureProjects(ownerId);

export const getProject = (ownerId: string, projectId: string) =>
  ensureProjects(ownerId).find((project) => project.id === projectId) ?? null;

export const createProject = (ownerId: string, input: { name: string; description?: string }) => {
  const projects = ensureProjects(ownerId);
  const project: ProjectDetail = {
    id: crypto.randomUUID(),
    name: input.name,
    description: input.description?.trim() || 'New project',
    defaultModel: env.defaultModel,
    updatedAt: new Date().toISOString(),
    instructions:
      'You are the default project assistant. Be concise, implementation-oriented, and prefer safe backend-managed workflows.',
  };

  projects.unshift(project);
  return project;
};
