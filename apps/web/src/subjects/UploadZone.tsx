import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { ID, UploadResult } from '@studi0/shared';
import { displayError, uploadFiles } from '../api/client';
import { ErrorBanner } from '../components/ErrorBanner';
import { formatBytes } from '../lib/format';

export function UploadZone({
  subjectId,
  onUploaded,
}: {
  subjectId: ID;
  onUploaded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(list: FileList | File[]): Promise<void> {
    const files = Array.from(list);
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of files) form.append('files', f, f.name);
      setResult(await uploadFiles(subjectId, form));
      onUploaded();
    } catch (e) {
      setError(displayError(e));
    } finally {
      setBusy(false);
      if (inputRef.current !== null) inputRef.current.value = '';
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setOver(false);
    void upload(e.dataTransfer.files);
  }

  return (
    <section aria-labelledby="upload-title" className="panel">
      <h3 id="upload-title">Upload material</h3>
      <div
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <p>Drop PDF or Markdown files here — they land in material/.</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.md"
          aria-label="Choose files to upload"
          onChange={(e) => void upload(e.target.files ?? [])}
        />
        <p className="muted">Only .pdf and .md are supported; anything else is rejected per file.</p>
      </div>
      {busy && (
        <p role="status" className="muted">
          Uploading…
        </p>
      )}
      {error !== null && <ErrorBanner message={error} />}
      {result !== null && (
        <div className="upload-result" role="region" aria-label="Upload result" aria-live="polite">
          {result.accepted.length > 0 && (
            <>
              <p>
                <strong>Accepted {result.accepted.length}:</strong>
              </p>
              <ul>
                {result.accepted.map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code> ({formatBytes(f.bytes)})
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.rejected.length > 0 && (
            <>
              <p>
                <strong>Rejected {result.rejected.length}:</strong>
              </p>
              <ul>
                {result.rejected.map((r) => (
                  <li key={r.name}>
                    <code>{r.name}</code> — {r.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
