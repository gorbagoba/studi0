import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ID } from '@studi0/shared';

export type Tab = 'material' | 'graph' | 'lessons' | 'chat' | 'practice';

interface AppState {
  subjectId: ID | null;
  tab: Tab;
  lessonPath: string | null;
  selectSubject: (id: ID | null) => void;
  setTab: (tab: Tab) => void;
  openLesson: (path: string) => void;
  closeLesson: () => void;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [subjectId, setSubjectId] = useState<ID | null>(null);
  const [tab, setTab] = useState<Tab>('material');
  const [lessonPath, setLessonPath] = useState<string | null>(null);
  const value = useMemo<AppState>(
    () => ({
      subjectId,
      tab,
      lessonPath,
      selectSubject: (id) => {
        setSubjectId(id);
        setTab('material');
        setLessonPath(null);
      },
      setTab,
      openLesson: (path) => {
        setLessonPath(path);
        setTab('lessons');
      },
      closeLesson: () => setLessonPath(null),
    }),
    [subjectId, tab, lessonPath],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (ctx === null) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
