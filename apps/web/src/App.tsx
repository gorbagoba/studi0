import { EmptyState } from './components/EmptyState';
import { ThemeToggle } from './components/ThemeToggle';
import { Sidebar } from './subjects/Sidebar';
import { SubjectPage } from './subjects/SubjectPage';
import { SettingsPage } from './settings/SettingsPage';
import { AppProvider, useApp } from './state/app';

function Shell() {
  const { subjectId, settingsOpen } = useApp();
  return (
    <div className="app">
      <ThemeToggle />
      <Sidebar />
      <main className="main">
        {settingsOpen ? (
          <SettingsPage />
        ) : subjectId !== null ? (
          <SubjectPage key={subjectId} subjectId={subjectId} />
        ) : (
          <EmptyState
            title="No subject selected"
            hint="Choose a subject on the left, or add one."
          />
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
