import { HomePage } from './home/HomePage';
import { Sidebar } from './subjects/Sidebar';
import { SubjectPage } from './subjects/SubjectPage';
import { SettingsPage } from './settings/SettingsPage';
import { AppProvider, useApp } from './state/app';
import { ToastProvider } from './components/Toast';

function Shell() {
  const { subjectId, settingsOpen } = useApp();
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {settingsOpen ? (
          <SettingsPage />
        ) : subjectId !== null ? (
          <SubjectPage key={subjectId} subjectId={subjectId} />
        ) : (
          <HomePage />
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </AppProvider>
  );
}
