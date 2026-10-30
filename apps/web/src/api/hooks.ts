import { useEffect, useState } from 'react';
import type {
  ChatSession,
  GraphInfo,
  GraphReport,
  ID,
  Lesson,
  Question,
  Stats,
  Subject,
  SubjectDetail,
  TreeDir,
  TreeResponse,
  WikiPage,
} from '@studi0/shared';
import { displayError } from './client';
import * as client from './client';

export interface FetchState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Small fetch hook; refetches when `deps` change or `reload()` is called (SSE-driven invalidation). */
export function useFetch<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
): FetchState<T> & { reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetcher()
      .then((d) => {
        if (live) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (live) {
          setError(displayError(e));
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

export const useSubjects = (): FetchState<Subject[]> & { reload: () => void } =>
  useFetch(client.getSubjects, []);

export const useSubject = (id: ID): FetchState<SubjectDetail> & { reload: () => void } =>
  useFetch(() => client.getSubject(id), [id]);

export const useTree = (
  id: ID,
  dir: TreeDir,
  version: number,
): FetchState<TreeResponse> & { reload: () => void } =>
  useFetch(() => client.getTree(id, dir), [id, dir, version]);

export const useLessons = (id: ID, version: number): FetchState<Lesson[]> & { reload: () => void } =>
  useFetch(() => client.getLessons(id), [id, version]);

export const useGraphInfo = (
  id: ID,
  version: number,
): FetchState<GraphInfo> & { reload: () => void } =>
  useFetch(() => client.getGraph(id), [id, version]);

export const useReport = (
  id: ID,
  version: number,
): FetchState<GraphReport> & { reload: () => void } =>
  useFetch(() => client.getReport(id), [id, version]);

export const useWiki = (
  id: ID,
  version: number,
): FetchState<{ pages: { name: string; updatedAt: string }[] }> & { reload: () => void } =>
  useFetch(() => client.getWiki(id), [id, version]);

export const useWikiPage = (
  id: ID,
  name: string | null,
  version: number,
): FetchState<WikiPage | null> & { reload: () => void } =>
  useFetch(() => (name === null ? Promise.resolve(null) : client.getWikiPage(id, name)), [
    id,
    name,
    version,
  ]);

export const useQuestions = (
  id: ID,
  topic: string,
  type: '' | QuestionTypeFilter,
  version: number,
): FetchState<Question[]> & { reload: () => void } =>
  useFetch(() => client.getQuestions(id, topic, type), [id, topic, type, version]);

export const useDue = (id: ID, version: number): FetchState<DueState> & { reload: () => void } =>
  useFetch(() => client.getDue(id), [id, version]);

export const useStats = (id: ID, version: number): FetchState<Stats> & { reload: () => void } =>
  useFetch(() => client.getStats(id), [id, version]);

export const useSessions = (id: ID): FetchState<ChatSession[]> & { reload: () => void } =>
  useFetch(() => client.getSessions(id), [id]);

export type QuestionTypeFilter = 'mcq' | 'short' | 'code';
export type DueState = { date: string; questions: Question[] };
