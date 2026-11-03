import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ID } from '@studi0/shared';

export type Tab = 'overview' | 'material' | 'graph' | 'lessons' | 'chat' | 'practice' | 'setup';

interface AppState {
  subjectId: ID | null;
  tab: Tab;
  lessonPath: string | null;
  settingsOpen: boolean;
  selectSubject: (id: ID | null) => void;
  setTab: (tab: Tab) => void;
  openLesson: (path: string) => void;
  closeLesson: () => void;
  setSettingsOpen: (open: boolean) => void;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [subjectId, setSubjectId] = useState<ID | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [lessonPath, setLessonPath] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const value = useMemo<AppState>(
    () => ({
      subjectId,
      tab,
      lessonPath,
      settingsOpen,
      selectSubject: (id) => {
        setSubjectId(id);
        setTab('overview');
        setLessonPath(null);
        setSettingsOpen(false);
      },
      setTab,
      openLesson: (path) => {
        setLessonPath(path);
        setTab('lessons');
      },
      closeLesson: () => setLessonPath(null),
      setSettingsOpen,
    }),
    [subjectId, tab, lessonPath, settingsOpen],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (ctx === null) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
